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
			cat, err := catalog.Load(catalogRoot())
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

// catalogRoot returns the repo root that holds catalog/ from the CLI's cwd.
func catalogRoot() string {
	if cfg, err := appconfig.Resolve(); err == nil {
		return cfg.Catalog
	}
	return "catalog"
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
