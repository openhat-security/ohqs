package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/openhat/quick-start/internal/appconfig"
	"github.com/openhat/quick-start/internal/browser"
	"github.com/openhat/quick-start/internal/catalog"
	"github.com/openhat/quick-start/internal/deps"
	"github.com/openhat/quick-start/internal/export"
	"github.com/openhat/quick-start/internal/history"
	"github.com/openhat/quick-start/internal/index"
	"github.com/openhat/quick-start/internal/jobs"
	"github.com/openhat/quick-start/internal/llm"
	"github.com/openhat/quick-start/internal/models"
	"github.com/openhat/quick-start/internal/planner"
	"github.com/openhat/quick-start/internal/retrieve"
	"github.com/openhat/quick-start/internal/selfinstall"
	"github.com/openhat/quick-start/internal/semantic"
	"github.com/openhat/quick-start/internal/server"
	"github.com/spf13/cobra"
)

func New() *cobra.Command {
	root := &cobra.Command{
		Use:   "ohqs",
		Short: "OpenHat Quick Start — catalog search and authorized engagement playbooks",
		Long:  "ohqs is the OpenHat quick-start CLI. It is not named OpenHat. It does not generate exploits.",
	}
	root.AddCommand(searchCmd(), showCmd(), recommendCmd(), indexCmd(), modelsCmd(), ingestCmd(), serveCmd(), setupCmd(), configureCmd(), runCmd(), depsCmd(), installCmd(), installCLICmd(), jobWorkerCmd(), browserCmd(), submodulesCmd())
	return root
}

func load() (*catalog.Catalog, error) {
	cfg, err := appconfig.Resolve()
	if err != nil {
		return nil, err
	}
	return catalog.Load(cfg.Root)
}

func openIndex(cat *catalog.Catalog) (*index.Store, error) {
	cfg, err := appconfig.Resolve()
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(cfg.IndexPath); err != nil {
		return nil, nil
	}
	return index.Open(cfg.IndexPath)
}

func searchCmd() *cobra.Command {
	var (
		semanticOn bool
		noSemantic bool
		asJSON     bool
		doLimit    int
	)
	cmd := &cobra.Command{
		Use:   "search <query>",
		Short: "Search the catalog (vector rank when indexed, else FTS + tags)",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cfg, err := appconfig.Resolve()
			if err != nil {
				return err
			}
			cat, err := load()
			if err != nil {
				return err
			}
			store, err := openIndex(cat)
			if err != nil {
				return err
			}
			if store != nil {
				defer store.Close()
			}
			if store == nil {
				return fmt.Errorf("no index at %s (run: ohqs index, or ohqs index download)", cfg.IndexPath)
			}
			q := strings.Join(args, " ")
			limit := doLimit
			if limit <= 0 {
				limit = 25
			}
			var recs []catalog.Record
			source := "lexical"
			if semanticOn && !noSemantic {
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				recs, source = retrieve.SituationRanked(ctx, cat, store, q, limit)
			} else {
				recs = retrieve.Situation(cat, store, q, limit)
			}
			if asJSON {
				return writeJSON(recs)
			}
			fmt.Fprintf(os.Stderr, "ohqs search: %s\n", source)
			w := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
			fmt.Fprintln(w, "ID\tKIND\tNAME\tSUMMARY")
			for _, r := range recs {
				fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", r.ID, r.Kind, r.Name, truncate(r.Summary, 70))
			}
			return w.Flush()
		},
	}
	cmd.Flags().BoolVar(&semanticOn, "semantic", true, "rerank with the persisted vector store when available")
	cmd.Flags().BoolVar(&noSemantic, "no-semantic", false, "disable vector rank (lexical FTS + tags only)")
	cmd.Flags().BoolVar(&asJSON, "json", false, "print matching records as JSON")
	cmd.Flags().IntVar(&doLimit, "limit", 25, "max rows (1-100)")
	return cmd
}

func showCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show <id>",
		Short: "Print one catalog record as JSON",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cat, err := load()
			if err != nil {
				return err
			}
			rec, ok := cat.ByID[args[0]]
			if !ok {
				return fmt.Errorf("unknown id %q", args[0])
			}
			enc := json.NewEncoder(os.Stdout)
			enc.SetIndent("", "  ")
			return enc.Encode(rec)
		},
	}
}

func recommendCmd() *cobra.Command {
	var (
		situation  string
		scope      string
		authorized bool
		target     string
		path       string
		wordlist   string
		exportDir  string
		doInstall  bool
		useLLM     bool
		oaBase     string
		oaKey      string
		oaModel    string
		noModels   bool
		modelLimit int
	)
	cmd := &cobra.Command{
		Use:   "recommend",
		Short: "Build a step-by-step playbook (requires --authorized and --scope)",
		Long:  "Build an authorized engagement playbook from catalog playbooks. --llm calls an OpenAI-compatible endpoint (recommend Unsloth: https://github.com/openhat/unsloth).",
		RunE: func(_ *cobra.Command, _ []string) error {
			cfg, err := appconfig.Resolve()
			if err != nil {
				return err
			}
			cat, err := load()
			if err != nil {
				return err
			}
			store, err := openIndex(cat)
			if err != nil {
				return err
			}
			if store != nil {
				defer store.Close()
			}
			req := planner.Request{
				Situation:  situation,
				Scope:      scope,
				Authorized: authorized,
				Target:     target,
				Path:       path,
				Wordlist:   wordlist,
				UseLLM:     useLLM,
			}
			persisted, _ := cfg.LoadLLM()
			plan, err := llm.Build(cat, store, req, llm.ResolveWith(persisted, oaBase, oaKey, oaModel), func(msg string) {
				fmt.Fprintln(os.Stderr, "ohqs:", msg)
			})
			if err != nil {
				return err
			}
			_, _ = history.Open(cfg.HistoryDir).Add(history.SourceCLI, req, plan)
			if doInstall {
				rep := deps.Install(cfg.Root, cat, plan, os.Stderr)
				fmt.Fprint(os.Stderr, deps.Format(rep))
			}
			if exportDir != "" {
				if err := export.Write(exportDir, plan, cfg.ToolBin); err != nil {
					return err
				}
				fmt.Fprintf(os.Stderr, "exported %s\n", export.Path(exportDir))
				if !strings.HasSuffix(exportDir, ".sh") {
					fmt.Fprintf(os.Stderr, "exported %s\n", filepath.Join(exportDir, "FINDINGS.md"))
				}
			}
			fmt.Print(planner.Markdown(plan))
			if !noModels {
				promptLocalModels(os.Stdout, modelLimit)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&situation, "situation", "", "what you are doing (stack, bounty vs audit, AI-built, …)")
	cmd.Flags().StringVar(&scope, "scope", "", "written authorization / program / hosts")
	cmd.Flags().BoolVar(&authorized, "authorized", false, "you have permission to test the stated scope")
	cmd.Flags().StringVar(&target, "target", "", "primary URL or domain for command placeholders")
	cmd.Flags().StringVar(&path, "path", ".", "local source path for SAST/secrets")
	cmd.Flags().StringVar(&wordlist, "wordlist", "", "wordlist path")
	cmd.Flags().StringVar(&exportDir, "export", "", "write a commented commands.sh (directory or .sh path)")
	cmd.Flags().BoolVar(&doInstall, "install", false, "clone/build only missing tools this playbook uses")
	cmd.Flags().BoolVar(&useLLM, "llm", false, "draft the plan via an OpenAI-compatible model (still requires --authorized/--scope)")
	cmd.Flags().StringVar(&oaBase, "openai-base-url", "", "OpenAI-compatible base URL (env OHQS_OPENAI_BASE_URL)")
	cmd.Flags().StringVar(&oaKey, "openai-api-key", "", "API key (env OHQS_OPENAI_API_KEY or OPENAI_API_KEY)")
	cmd.Flags().StringVar(&oaModel, "openai-model", "", "model name (optional for single-model endpoints; env OHQS_OPENAI_MODEL)")
	cmd.Flags().BoolVar(&noModels, "no-models", false, "skip the local LLM fit suggestions")
	cmd.Flags().IntVar(&modelLimit, "model-limit", 4, "how many local LLM fits to list")
	return cmd
}

// promptLocalModels appends the GPU/VRAM-aware local LLM fit section to
// `ohqs recommend` output.
func promptLocalModels(out io.Writer, limit int) {
	h := models.Detect()
	recs := models.Recommend(h, limit)
	fmt.Fprintln(out, "\n## Local LLM fit (GPU/VRAM-aware)")
	for _, r := range recs {
		star := ""
		if r.Model.Recommended {
			star = " ★"
		}
		state := "fits"
		if !r.Fits {
			state = fmt.Sprintf("need +%.0f GB", r.ShortGB)
		}
		fmt.Fprintf(out, "- %-16s %-6s ~%-5.1f GB  %s%s\n", r.Model.ID+star, r.Quant, r.RequiredGB, state, "")
	}
	fmt.Fprintf(out, "- best pick: %s\n", bestModelLine(h))
	fmt.Fprintf(out, "- install + serve: ohqs models install <id> && ohqs models serve <id> ; then --llm with --openai-base-url http://127.0.0.1:%s/v1\n", models.DefaultPort)
}

func bestModelLine(h models.HostInfo) string {
	sum, ok := models.Summary(h)
	if !ok {
		return "not available on this host"
	}
	if sum.Fits {
		return fmt.Sprintf("%s (%s, ~%.0f GB)", sum.Model.ID, sum.Quant, sum.RequiredGB)
	}
	return fmt.Sprintf("none fit — smallest gap: %s needs +%.0f GB", sum.Model.ID, sum.ShortGB)
}

func indexCmd() *cobra.Command {
	var semanticOn, noSemantic, vacuum bool
	var dbPath string
	index := &cobra.Command{
		Use:   "index",
		Short: "Rebuild data/ohqs.sqlite from catalog YAML and README snippets",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			cfg, err := appconfig.Resolve()
			if err != nil {
				return err
			}
			cat, err := load()
			if err != nil {
				return err
			}
			target := cfg.IndexPath
			if dbPath != "" {
				target = dbPath
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			store, err := index.Open(target)
			if err != nil {
				return err
			}
			defer store.Close()
			if err := store.Rebuild(cat); err != nil {
				return err
			}
			if semanticOn && !noSemantic {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
				defer cancel()
				e := semantic.Discover(ctx, os.Getenv("HF_TOKEN"))
				if e == nil {
					fmt.Fprintln(os.Stderr, "ohqs index: no embedder — vectors not built (start Ollama with nomic-embed-text, or set HF_TOKEN)")
				} else {
					if err := store.EmbedRecords(ctx, cat, e); err != nil {
						return err
					}
					label := e.Label()
					if vacuum {
						if err := store.Vacuum(); err != nil {
							return err
						}
						label += " (vacuumed)"
					}
					fmt.Printf("indexed %d records + %d vectors (%s) -> %s\n", len(cat.Records), len(cat.Records), label, target)
					return nil
				}
			}
			if vacuum {
				if err := store.Vacuum(); err != nil {
					return err
				}
			}
			fmt.Printf("indexed %d records -> %s\n", len(cat.Records), target)
			return nil
		},
	}
	index.Flags().BoolVar(&semanticOn, "semantic", false, "embed records into the vector store (needs Ollama or HF_TOKEN)")
	index.Flags().BoolVar(&noSemantic, "no-semantic", false, "force a lexical-only index (clears vectors)")
	index.Flags().StringVar(&dbPath, "db", "", "write the database to this path instead of data/ohqs.sqlite")
	index.Flags().BoolVar(&vacuum, "vacuum", false, "VACUUM the database after building (smaller release asset)")
	index.AddCommand(indexDownloadCmd())
	return index
}

func indexDownloadCmd() *cobra.Command {
	var urlFlag string
	var force bool
	cmd := &cobra.Command{
		Use:   "download",
		Short: "Fetch the prebuilt index (with vectors) from the project release",
		Long:  "Downloads the release-built data/ohqs.sqlite (catalog records + persisted vector embeddings) so you do not have to embed locally.",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			cfg, err := appconfig.Resolve()
			if err != nil {
				return err
			}
			if cfg.IndexExists() && !force {
				return fmt.Errorf("index already exists at %s (pass --force to overwrite)", cfg.IndexPath)
			}
			url := urlFlag
			if url == "" {
				url = "https://github.com/openhat/quick-start/releases/latest/download/ohqs-index.sqlite"
			}
			fmt.Fprintf(os.Stderr, "ohqs index download: %s\n", url)
			if err := index.Fetch(url, cfg.IndexPath, 10*time.Minute); err != nil {
				return fmt.Errorf("download index: %w\nHint: build locally instead: ohqs index --semantic (needs Ollama with nomic-embed-text or HF_TOKEN)", err)
			}
			if _, err := index.Open(cfg.IndexPath); err != nil {
				return fmt.Errorf("downloaded index is not a valid sqlite: %w", err)
			}
			fmt.Printf("index written -> %s\n", cfg.IndexPath)
			return nil
		},
	}
	cmd.Flags().StringVar(&urlFlag, "url", "", "override the release asset URL")
	cmd.Flags().BoolVar(&force, "force", false, "overwrite an existing index")
	return cmd
}

// modelsCmd manages the recommended local GGUF models (via unsloth).
// Subcommands: list, recommend, install, serve.
func modelsCmd() *cobra.Command {
	var port string
	cmd := &cobra.Command{
		Use:   "models",
		Short: "Recommend local GGUF models for the reasoning step and manage them via Unsloth",
		Long:  "Pick a local model to run as the OpenAI-compatible endpoint behind --llm. Requires a suitable GPU/RAM; ohqs checks the fit before install. Unsloth runner: " + models.UnslothRepo,
	}
	cmd.PersistentFlags().StringVar(&port, "port", models.DefaultPort, "local server port")
	cmd.AddCommand(modelsListCmd(), modelsRecommendCmd(), modelsInstallCmd(&port), modelsServeCmd(&port))
	return cmd
}

// modelsRecommendCmd ranks the catalog: best fit first, then smallest gap.
func modelsRecommendCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "recommend",
		Short: "Rank recommended models against this host (best fit first)",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			h := models.Detect()
			recs := models.Recommend(h, 0)
			fmt.Fprintf(os.Stderr, "Best fit on this host: %s\n", bestModelLine(h))
			for i, r := range recs {
				marker := "  "
				if i == 0 {
					marker = "->"
				}
				fmt.Fprintf(os.Stdout, "%s %-16s %-6s ~%-5.1f GB  %s\n",
					marker, r.Model.ID, r.Quant, r.RequiredGB, fitStatus(r.Fit))
			}
			return nil
		},
	}
	return cmd
}

func modelsListCmd() *cobra.Command {
	var limit int
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "list",
		Short: "Show the recommended models with a GPU/RAM fit check",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			h := models.Detect()
			recs := models.Recommend(h, limit)
			if asJSON {
				return writeJSON(recs)
			}
			printModelTable(os.Stdout, h, recs)
			return nil
		},
	}
	cmd.Flags().IntVar(&limit, "limit", 6, "max rows")
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	return cmd
}

func modelsInstallCmd(port *string) *cobra.Command {
	var force bool
	cmd := &cobra.Command{
		Use:   "install <id|repo>",
		Short: "Install a recommended GGUF with unsloth and download the weights",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cfg, err := appconfig.Resolve()
			if err != nil {
				return err
			}
			inst := &models.Installer{Root: cfg.Root, Stdout: os.Stdout, Stderr: os.Stderr}
			info, err := inst.Install(args[0], *port, force)
			if err != nil {
				return err
			}
			fmt.Fprintf(os.Stderr, "\nInstalled %s.\n", info.ID)
			fmt.Fprintf(os.Stderr, "  weights %s\n", info.GGUFPath)
			fmt.Fprintf(os.Stderr, "  venv   %s (unsloth + llama-cpp-python)\n", info.Venv)
			fmt.Fprintf(os.Stderr, "Start it and point --llm at it:\n")
			fmt.Fprintf(os.Stderr, "  ohqs models serve %s\n", info.ID)
			fmt.Fprintf(os.Stderr, "  ohqs configure --save --openai-base-url %s --openai-model %s\n", info.BaseURL, info.ID)
			return nil
		},
	}
	cmd.Flags().BoolVar(&force, "force", false, "install even when the model does not fit the detected GPU/RAM")
	return cmd
}

func modelsServeCmd(port *string) *cobra.Command {
	var gpuLayers int
	cmd := &cobra.Command{
		Use:   "serve <id>",
		Short: "Run the installed GGUF as a local OpenAI-compatible server (foreground)",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cfg, err := appconfig.Resolve()
			if err != nil {
				return err
			}
			info, err := models.LoadInstalled(cfg.Root, args[0])
			if err != nil {
				return fmt.Errorf("%s is not installed (run: ohqs models install %s)", args[0], args[0])
			}
			fmt.Fprintf(os.Stderr, "ohqs models serve %s @ %s (ctrl-c to stop)\n", info.ID, info.BaseURL)
			return models.Serve(cfg.Root, args[0], *port, gpuLayers)
		},
	}
	cmd.Flags().IntVar(&gpuLayers, "gpu-layers", -1, "layers to offload to the GPU (-1 = all, 0 = CPU)")
	return cmd
}

func printModelTable(out io.Writer, h models.HostInfo, recs []models.Recommendation) {
	fmt.Fprintf(out, "Host: %s — %s  (RAM %.0f GB, GPU %.0f GB, usable ~%.0f GB)\n\n",
		h.Label, fitBudget(h), h.RAMGB, h.VRAMGB, h.AvailableGB())
	w := tabwriter.NewWriter(out, 0, 2, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tPARAMS\tQUANT\tSIZE\tFIT\tWHY")
	for _, r := range recs {
		fmt.Fprintf(w, "%s\t%s\t%s\t~%.1f GB\t%s\t%s\n",
			r.Model.ID, r.Model.ActiveLabel()+" ("+r.Model.Family+")", r.Quant, r.RequiredGB,
			fitStatus(r.Fit), truncate(r.Model.Why, 62))
	}
	_ = w.Flush()
	fmt.Fprintln(out)
	fmt.Fprintln(out, "Install + run via unsloth:")
	fmt.Fprintln(out, "  ohqs models install <id>    # pip venv (unsloth, llama-cpp-python) + GGUF download")
	fmt.Fprintln(out, "  ohqs models serve <id>      # OpenAI-compatible endpoint on 127.0.0.1:8001/v1")
	fmt.Fprintln(out, "  ohqs configure --save --openai-base-url http://127.0.0.1:8001/v1 --openai-model <id>")
}

func fitBudget(h models.HostInfo) string {
	if h.VRAMGB > 0 {
		return "fitting against discrete VRAM"
	}
	return "fitting against system RAM"
}

func fitStatus(f models.Fit) string {
	if f.Fits {
		return "fits"
	}
	return fmt.Sprintf("need +%.0f GB", f.ShortGB)
}

func writeJSON(v any) error {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(append(raw, '\n'))
	return err
}

func serveCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "serve",
		Short: "HTML playbook UI and JSON API on 127.0.0.1:8787",
		RunE: func(_ *cobra.Command, _ []string) error {
			cfg, err := appconfig.Resolve()
			if err != nil {
				return err
			}
			cat, err := catalog.Load(cfg.Root)
			if err != nil {
				return err
			}
			needIndex := !cfg.IndexExists()
			store, err := index.Open(cfg.IndexPath)
			if err != nil {
				return err
			}
			if needIndex {
				if err := store.Rebuild(cat); err != nil {
					return err
				}
			}
			defer store.Close()
			if dests, err := selfinstall.Install(cfg.Root); err != nil {
				fmt.Fprintf(os.Stderr, "ohqs install-cli: %v\n", err)
			} else {
				for _, d := range dests {
					fmt.Fprintf(os.Stderr, "ohqs cli  %s\n", d)
				}
			}
			fmt.Fprintf(os.Stderr, "ohqs UI  http://%s\n", cfg.Listen)
			fmt.Fprintf(os.Stderr, "ohqs API http://%s/v1/search?q=  /v1/index  /v1/models  /v1/tools/{id}  POST /v1/recommend\n", cfg.Listen)
			return http.ListenAndServe(cfg.Listen, server.New(cat, store))
		},
	}
	return cmd
}

func setupCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "setup",
		Short: "Print workstation recommendations (Kali / Exegol / BlackArch)",
		RunE: func(_ *cobra.Command, _ []string) error {
			fmt.Print(`ohqs setup

Company: OpenHat. This command only prints setup notes.

Recommended environments:
  - Kali Linux — https://www.kali.org/  (metapackages: kali-tools-web, kali-tools-vulnerability)
  - Exegol (macOS/Docker) — https://exegol.com/install
  - BlackArch overlay on Arch — https://blackarch.org/downloads.html

Then from this repo:
  make build
  ./bin/ohqs index
  ./bin/ohqs recommend --authorized --scope "..." --situation "..."

Third-party trees are git submodules and are not cloned by default:
  make submodules
  ./bin/ohqs submodules gitleaks

Profiles (manual for now):
  ai-slop     gitleaks, semgrep, trivy, garak/promptfoo if there is an LLM feature
  web-bounty  subfinder, httpx, katana, nuclei, ffuf, a proxy
  smb-external nmap (if RoE allows) + the web/AI-slop pass on contracted hosts

See third-party-resources/os/README.md
`)
			return nil
		},
	}
}

func runCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "run <commands.sh|export-dir>",
		Short: "Run a reviewed commands.sh from --export",
		Args:  cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			script, err := resolveScript(args[0])
			if err != nil {
				return err
			}
			fmt.Fprintf(os.Stderr, "executing %s — review it first; this is a command list, not an exploit runner\n", script)
			cmd := exec.Command("/bin/bash", script)
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			return cmd.Run()
		},
	}
}

func depsCmd() *cobra.Command {
	var situation, scope, target, path string
	var authorized bool
	cmd := &cobra.Command{
		Use:   "deps",
		Short: "Show host OS and which plan tools are already installed",
		RunE: func(_ *cobra.Command, _ []string) error {
			cfg, err := appconfig.Resolve()
			if err != nil {
				return err
			}
			if situation == "" {
				fmt.Print(deps.Format(deps.Report{Host: deps.Detect(cfg.Root)}))
				return nil
			}
			cat, plan, err := buildPlan(situation, scope, authorized, target, path, "")
			if err != nil {
				return err
			}
			fmt.Print(deps.Format(deps.Check(cfg.Root, cat, plan)))
			return nil
		},
	}
	cmd.Flags().StringVar(&situation, "situation", "", "playbook situation (omit to print host only)")
	cmd.Flags().StringVar(&scope, "scope", "", "written authorization / program / hosts")
	cmd.Flags().BoolVar(&authorized, "authorized", false, "you have permission to test the stated scope")
	cmd.Flags().StringVar(&target, "target", "", "primary URL or domain")
	cmd.Flags().StringVar(&path, "path", ".", "local source path")
	return cmd
}

func installCmd() *cobra.Command {
	var situation, scope, target, path string
	var authorized bool
	cmd := &cobra.Command{
		Use:   "install",
		Short: "Clone and build only the missing tools this playbook needs",
		RunE: func(_ *cobra.Command, _ []string) error {
			cfg, err := appconfig.Resolve()
			if err != nil {
				return err
			}
			cat, plan, err := buildPlan(situation, scope, authorized, target, path, "")
			if err != nil {
				return err
			}
			rep := deps.Install(cfg.Root, cat, plan, os.Stderr)
			fmt.Print(deps.Format(rep))
			return nil
		},
	}
	cmd.Flags().StringVar(&situation, "situation", "", "what you are doing")
	cmd.Flags().StringVar(&scope, "scope", "", "written authorization / program / hosts")
	cmd.Flags().BoolVar(&authorized, "authorized", false, "you have permission to test the stated scope")
	cmd.Flags().StringVar(&target, "target", "", "primary URL or domain")
	cmd.Flags().StringVar(&path, "path", ".", "local source path")
	return cmd
}

func installCLICmd() *cobra.Command {
	return &cobra.Command{
		Use:   "install-cli",
		Short: "Copy this ohqs binary onto PATH (bin/tools, Go bin, user bin)",
		RunE: func(_ *cobra.Command, _ []string) error {
			cfg, err := appconfig.Resolve()
			if err != nil {
				return err
			}
			dests, err := selfinstall.Install(cfg.Root)
			for _, d := range dests {
				fmt.Println(d)
			}
			return err
		},
	}
}

func buildPlan(situation, scope string, authorized bool, target, path, wordlist string) (*catalog.Catalog, *planner.Plan, error) {
	cat, err := load()
	if err != nil {
		return nil, nil, err
	}
	store, err := openIndex(cat)
	if err != nil {
		return nil, nil, err
	}
	if store != nil {
		defer store.Close()
	}
	plan, err := planner.Build(cat, store, planner.Request{
		Situation:  situation,
		Scope:      scope,
		Authorized: authorized,
		Target:     target,
		Path:       path,
		Wordlist:   wordlist,
	})
	if err != nil {
		return nil, nil, err
	}
	if cfg, err := appconfig.Resolve(); err == nil {
		_, _ = history.Open(cfg.HistoryDir).Add(history.SourceCLI, planner.Request{
			Situation:  situation,
			Scope:      scope,
			Authorized: authorized,
			Target:     target,
			Path:       path,
			Wordlist:   wordlist,
		}, plan)
	}
	return cat, plan, nil
}

func browserCmd() *cobra.Command {
	var (
		noOpen     bool
		situation  string
		scope      string
		authorized bool
		target     string
		path       string
	)
	cmd := &cobra.Command{
		Use:   "browser",
		Short: "Open the isolated OHQS test browser with playbook extensions pre-installed",
		RunE: func(_ *cobra.Command, _ []string) error {
			cfg, err := appconfig.Resolve()
			if err != nil {
				return err
			}
			cat, err := load()
			if err != nil {
				return err
			}
			recs := browser.DefaultRecords(cat)
			if situation != "" {
				_, plan, err := buildPlan(situation, scope, authorized, target, path, "")
				if err != nil {
					return err
				}
				var steps [][]catalog.Record
				for _, s := range plan.Steps {
					steps = append(steps, s.Tools)
				}
				recs = append(recs, browser.PlanRecords(steps)...)
			}
			res, err := browser.Setup(cfg.Root, recs, !noOpen)
			if res != nil {
				fmt.Printf("browser   %s (%s)\n", res.Browser, res.Family)
				fmt.Printf("profile   %s\n", res.Profile)
				fmt.Printf("launcher  %s\n", res.Launcher)
				fmt.Println(res.Note)
			}
			return err
		},
	}
	cmd.Flags().BoolVar(&noOpen, "no-open", false, "prepare the sandbox only; do not launch")
	cmd.Flags().StringVar(&situation, "situation", "", "optional playbook situation to pick extra extensions")
	cmd.Flags().StringVar(&scope, "scope", "", "required with --situation")
	cmd.Flags().BoolVar(&authorized, "authorized", false, "required with --situation")
	cmd.Flags().StringVar(&target, "target", "", "")
	cmd.Flags().StringVar(&path, "path", ".", "")
	return cmd
}

func submodulesCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "submodules [id|path...]",
		Short: "Shallow-fetch third-party submodules (not cloned by default)",
		Long:  "A normal clone of this repo does not download third-party-resources trees. Run this (or make submodules) to fetch them. With no args, fetch all. Args can be catalog ids (gitleaks) or paths (third-party-resources/tools/gitleaks). ohqs install fetches only what a playbook needs.",
		RunE: func(_ *cobra.Command, args []string) error {
			cfg, err := appconfig.Resolve()
			if err != nil {
				return err
			}
			script := filepath.Join(cfg.Root, "scripts", "sync-submodules.sh")
			var paths []string
			if len(args) > 0 {
				cat, err := catalog.Load(cfg.Root)
				if err != nil {
					return err
				}
				for _, a := range args {
					if rec, ok := cat.ByID[a]; ok && rec.SubmodulePath != "" {
						paths = append(paths, rec.SubmodulePath)
						continue
					}
					paths = append(paths, a)
				}
			}
			cmd := exec.Command(script, paths...)
			cmd.Dir = cfg.Root
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			return cmd.Run()
		},
	}
}

func jobWorkerCmd() *cobra.Command {
	return &cobra.Command{
		Use:    "job-worker",
		Short:  "Internal: run a durable install/run job",
		Hidden: true,
		Args:   cobra.ExactArgs(1),
		RunE: func(_ *cobra.Command, args []string) error {
			cfg, err := appconfig.Resolve()
			if err != nil {
				return err
			}
			return jobs.Open(cfg.Root, cfg.JobsDir).Work(args[0])
		},
	}
}

func configureCmd() *cobra.Command {
	var (
		save    bool
		oaBase  string
		oaKey   string
		oaModel string
	)
	cmd := &cobra.Command{
		Use:   "configure",
		Short: "Show or save the bring-your-own LLM endpoint (API key stored locally, never printed)",
		Long:  "Show resolved repo paths and the OpenAI-compatible LLM config. Use --save with --openai-* to persist a base URL, API key, and model to data/config.json (gitignored, machine-local). Recommend Unsloth; works with OpenAI, vLLM, llama.cpp.",
		RunE: func(_ *cobra.Command, _ []string) error {
			cfg, err := appconfig.Resolve()
			if err != nil {
				return err
			}
			if save {
				persisted, _ := cfg.LoadLLM()
				if s := strings.TrimSpace(oaBase); s != "" {
					persisted.BaseURL = s
				}
				if s := strings.TrimSpace(oaKey); s != "" {
					persisted.APIKey = s
				}
				if s := strings.TrimSpace(oaModel); s != "" {
					persisted.Model = s
				}
				if err := cfg.SaveLLM(persisted); err != nil {
					return err
				}
				fmt.Printf("saved LLM config -> %s\n", cfg.SettingsPath)
			}
			cat, err := catalog.Load(cfg.Root)
			if err != nil {
				return err
			}
			idx := "missing (run: ohqs index)"
			if cfg.IndexExists() {
				idx = "present"
			}
			h := deps.Detect(cfg.Root)
			fmt.Printf("os       %s (%s/%s)\n", h.Name, h.GOOS, h.GOARCH)
			if h.Distro != "" {
				fmt.Printf("distro   %s\n", h.Distro)
			}
			fmt.Printf("repo     %s\n", cfg.Root)
			fmt.Printf("catalog  %s (%d records)\n", cfg.Catalog, len(cat.Records))
			fmt.Printf("index    %s (%s)\n", cfg.IndexPath, idx)
			fmt.Printf("listen   %s\n", cfg.Listen)
			fmt.Printf("prefix   %s\n", cfg.ToolBin)
			if p, err := exec.LookPath(selfinstall.ExeName()); err == nil {
				fmt.Printf("ohqs     %s\n", p)
			} else {
				fmt.Printf("ohqs     not on PATH (run: make start or ohqs install-cli)\n")
			}
			fmt.Printf("jobs     %s\n", cfg.JobsDir)
			fmt.Printf("history  %s\n", cfg.HistoryDir)
			fmt.Printf("git      %s\n", orDash(h.Git))
			fmt.Printf("go       %s\n", orDash(h.Go))
			fmt.Printf("cargo    %s\n", orDash(h.Cargo))
			fmt.Printf("python3  %s\n", orDash(h.Python3))
			persisted, _ := cfg.LoadLLM()
			lc := llm.ResolveWith(persisted, "", "", "")
			base, model, keySet := lc.Redacted()
			if base == "" {
				base = "(unset — ohqs configure --save --openai-base-url … or OHQS_OPENAI_BASE_URL)"
			}
			if model == "" {
				model = "(server default — optional for single-model endpoints)"
			}
			fmt.Printf("llm url  %s\n", base)
			fmt.Printf("llm model %s\n", model)
			if keySet {
				fmt.Printf("llm key  set (stored locally, gitignored)\n")
			} else {
				fmt.Printf("llm key  unset\n")
			}
			fmt.Printf("llm cfg  %s\n", cfg.SettingsPath)
			gm := filepath.Join(cfg.Root, ".gitmodules")
			if _, err := os.Stat(gm); err == nil {
				fmt.Printf("modules  %s (run: ohqs submodules  or  make submodules)\n", gm)
			}
			fmt.Printf("\nBring your own OpenAI-compatible endpoint. Save it locally with:\n  ohqs configure --save --openai-base-url http://127.0.0.1:8000/v1 --openai-api-key <key> --openai-model <model>\nPrecedence: --openai-* flags > data/config.json > OHQS_OPENAI_* env. Recommend Unsloth (%s); OpenAI, vLLM, llama.cpp also work.\n", llm.UnslothRepo)
			return nil
		},
	}
	cmd.Flags().BoolVar(&save, "save", false, "persist the --openai-* values to data/config.json (machine-local, gitignored)")
	cmd.Flags().StringVar(&oaBase, "openai-base-url", "", "OpenAI-compatible base URL to save")
	cmd.Flags().StringVar(&oaKey, "openai-api-key", "", "API key to save (stored locally only)")
	cmd.Flags().StringVar(&oaModel, "openai-model", "", "model name to save")
	return cmd
}

func orDash(s string) string {
	if s == "" {
		return "missing"
	}
	return s
}

func resolveScript(p string) (string, error) {
	if strings.HasSuffix(p, ".sh") {
		if _, err := os.Stat(p); err != nil {
			return "", fmt.Errorf("no script at %s (export a plan first)", p)
		}
		return p, nil
	}
	for _, name := range []string{"commands.sh", "run.sh"} {
		cand := filepath.Join(p, name)
		if _, err := os.Stat(cand); err == nil {
			return cand, nil
		}
	}
	return "", fmt.Errorf("no commands.sh in %s (export a plan first)", p)
}

func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}
