package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/openhat/quick-start/internal/appconfig"
	"github.com/openhat/quick-start/internal/catalog"
	"github.com/openhat/quick-start/internal/ingest"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

// ingestCmd pulls curated lists (awesome-* READMEs) into catalog/ingested.yaml
// so a reviewer can bulk-add a source and then rebuild the index.
func ingestCmd() *cobra.Command {
	var (
		from     string
		rawURL   string
		kind     string
		out      string
		limit    int
		dryRun   bool
		sortByID bool
	)
	cmd := &cobra.Command{
		Use:   "ingest",
		Short: "Import a curated tool list into catalog/ingested.yaml",
		Long:  "Fetches an awesome-list-style README (a built-in source or --url), parses \"- [X](url) - desc\" items, de-dupes against the existing catalog, and appends new records to catalog/ingested.yaml for review.",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			src := rawURL
			if src == "" {
				if from == "" {
					from = "awesome-web-security"
				}
				u, ok := ingest.KnownSources[from]
				if !ok {
					return fmt.Errorf("unknown source %q — known: %s", from, knownSources())
				}
				src = u
			}
			if kind == "" {
				kind = "tool"
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			fmt.Fprintf(os.Stderr, "ohqs ingest: fetching %s\n", src)
			md, err := ingest.Fetch(ctx, src)
			if err != nil {
				return err
			}
			drafts := ingest.Build(ingest.Parse(md), kind)
			if limit > 0 && len(drafts) > limit {
				drafts = drafts[:limit]
			}
			cat, err := catalog.Load(rootDir())
			if err != nil {
				return err
			}
			added, skipped := ingest.Merge(cat, drafts)
			fmt.Printf("parsed %d entries -> %d new, %d already in catalog\n", len(drafts), len(added), skipped)
			if len(added) == 0 {
				return nil
			}
			if out == "" {
				out = filepath.Join(catalogRoot(), "ingested.yaml")
			}
			if dryRun {
				printAdded(os.Stdout, added)
				return nil
			}
			if err := appendIngested(out, added, sortByID); err != nil {
				return err
			}
			fmt.Printf("appended %d records -> %s (review, then `ohqs index`)\n", len(added), out)
			return nil
		},
	}
	cmd.Flags().StringVar(&from, "from", "awesome-web-security", "one of the built-in sources ("+knownSources()+")")
	cmd.Flags().StringVar(&rawURL, "url", "", "raw markdown URL to import instead of --from")
	cmd.Flags().StringVar(&kind, "kind", "tool", "default kind for entries that do not self-classify")
	cmd.Flags().StringVar(&out, "out", "", "target YAML file (default catalog/ingested.yaml)")
	cmd.Flags().IntVar(&limit, "limit", 0, "only import the first N new entries")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "print the records instead of writing the file")
	cmd.Flags().BoolVar(&sortByID, "sort", false, "sort entries by id before appending")
	cmd.AddCommand(ingestGitHubCmd())
	return cmd
}

func knownSources() string {
	keys := make([]string, 0, len(ingest.KnownSources))
	for k := range ingest.KnownSources {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return strings.Join(keys, ", ")
}

// ingestGitHubCmd crawls GitHub's Search API and appends catalog-record drafts
// for security tooling repos (by topic/query) into catalog/ingested.yaml.
func ingestGitHubCmd() *cobra.Command {
	var (
		q          string
		topics     string
		all        bool
		noArchived bool
		perQuery   int
		out        string
		kind       string
		dryRun     bool
		sortByID   bool
		limit      int
	)
	cmd := &cobra.Command{
		Use:   "github",
		Short: "Crawl GitHub for security tooling repos and import them",
		Long: "Queries the GitHub Search API (sorted by stars) and maps results onto " +
			"catalog records. Give --q (full GitHub query), --topics (comma list), or --all " +
			"for the recommended red/blue/offensive topic set. Uses GITHUB_TOKEN when set for " +
			"higher rate limits.",
		Args: cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			if q == "" && topics == "" && !all {
				return fmt.Errorf("nothing to search: pass --q, --topics, or --all")
			}
			var topicList []string
			if topics != "" {
				for _, t := range strings.Split(topics, ",") {
					t = strings.TrimSpace(t)
					if t == "" {
						continue
					}
					topicList = append(topicList, t)
				}
			}
			if all {
				topicList = append(topicList, "all")
			}
			per := perQuery
			if per <= 0 {
				per = 30
			}
			src := ingest.GitHubSource{Token: os.Getenv("GITHUB_TOKEN")}
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
			defer cancel()
			var drafts []catalog.Record
			seen := map[string]bool{}
			addAll := func(recs []catalog.Record) {
				for _, r := range recs {
					if seen[r.Homepage] {
						continue
					}
					seen[r.Homepage] = true
					drafts = append(drafts, r)
				}
			}
			runQuery := func(query string) error {
				recs, err := src.SearchRepos(ctx, query, noArchived, per)
				if err != nil {
					return err
				}
				addAll(recs)
				return nil
			}
			switch {
			case q != "":
				fmt.Fprintf(os.Stderr, "ohqs ingest github: searching %q (GITHUB_TOKEN %s)\n", q, tokenNote(src.Token))
				if err := runQuery(q); err != nil {
					return err
				}
			case len(topicList) > 0 && !containsTopic(topicList, "all"):
				fmt.Fprintf(os.Stderr, "ohqs ingest github: crawling topics [%s] (GITHUB_TOKEN %s)\n",
					strings.Join(topicList, ", "), tokenNote(src.Token))
				for _, t := range topicList {
					query := `topic:"` + t + `"`
					if err := runQuery(query); err != nil {
						return err
					}
				}
			case containsTopic(topicList, "all"):
				fmt.Fprintf(os.Stderr, "ohqs ingest github: crawling %d recommended topics (GITHUB_TOKEN %s)\n",
					len(ingest.RecommendTopicQueries), tokenNote(src.Token))
				for _, t := range ingest.RecommendTopicQueries {
					if err := runQuery(t); err != nil {
						return err
					}
				}
			}
			if limit > 0 && len(drafts) > limit {
				drafts = drafts[:limit]
			}
			cat, err := catalog.Load(rootDir())
			if err != nil {
				return err
			}
			added, skipped := ingest.Merge(cat, drafts)
			fmt.Printf("search returned %d repos -> %d new, %d already in catalog\n", len(drafts), len(added), skipped)
			if kind != "" {
				for i := range added {
					added[i].Kind = kind
				}
			}
			if len(added) == 0 {
				return nil
			}
			if out == "" {
				out = filepath.Join(catalogRoot(), "ingested.yaml")
			}
			if dryRun {
				printAdded(os.Stdout, added)
				return nil
			}
			if err := appendIngested(out, added, sortByID); err != nil {
				return err
			}
			fmt.Printf("appended %d records -> %s (review, then `ohqs index`)\n", len(added), out)
			return nil
		},
	}
	cmd.Flags().StringVar(&q, "q", "", "full GitHub repository search query (e.g. \"topic:malware-language:go\")")
	cmd.Flags().StringVar(&topics, "topics", "", "comma-separated topics to convert into a query (e.g. \"red-team,c2,recon\")")
	cmd.Flags().BoolVar(&all, "all", false, "crawl all recommended red/blue/offensive topics")
	cmd.Flags().BoolVar(&noArchived, "no-archived", true, "skip archived repositories")
	cmd.Flags().IntVar(&perQuery, "per-query", 30, "max results per query")
	cmd.Flags().IntVar(&limit, "limit", 0, "cap total records written")
	cmd.Flags().StringVar(&kind, "kind", "", "override kind for all imported records")
	cmd.Flags().StringVar(&out, "out", "", "target YAML file (default catalog/ingested.yaml)")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "print instead of writing")
	cmd.Flags().BoolVar(&sortByID, "sort", false, "sort by id before appending")
	return cmd
}

func tokenNote(tok string) string {
	if tok != "" {
		return "set"
	}
	return "not set (default 10 search req/min — set GITHUB_TOKEN for more)"
}

func containsTopic(list []string, want string) bool {
	for _, t := range list {
		if t == want {
			return true
		}
	}
	return false
}

// catalogRoot builds the path to the catalog YAML directory, and catalogLoad
// loads the catalog given the repo root (which catalog.Load expects).
func rootDir() string {
	if cfg, err := appconfig.Resolve(); err == nil {
		return cfg.Root
	}
	return "."
}

func catalogRoot() string {
	return filepath.Join(rootDir(), "catalog")
}

func appendIngested(path string, recs []catalog.Record, sortByID bool) error {
	existing := map[string]catalog.Record{}
	if b, err := os.ReadFile(path); err == nil {
		var wrap struct {
			Items []catalog.Record `yaml:"items"`
		}
		if err := yaml.Unmarshal(b, &wrap); err != nil {
			return fmt.Errorf("read existing %s: %w", path, err)
		}
		for _, r := range wrap.Items {
			existing[r.ID] = r
		}
	}
	all := make([]catalog.Record, 0, len(existing)+len(recs))
	for _, r := range existing {
		all = append(all, r)
	}
	all = append(all, recs...)
	if sortByID {
		sort.Slice(all, func(i, j int) bool { return all[i].ID < all[j].ID })
	}
	wrap := struct {
		Items []catalog.Record `yaml:"items"`
	}{Items: all}
	b, err := yaml.Marshal(wrap)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

func printAdded(w io.Writer, recs []catalog.Record) {
	tw := tabwriter.NewWriter(w, 0, 2, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tKIND\tNAME\tHOMEPAGE")
	for _, r := range recs {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", r.ID, r.Kind, r.Name, r.Homepage)
	}
	_ = tw.Flush()
}
