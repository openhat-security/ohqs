package deps

import (
	"path/filepath"
	"runtime"
	"strings"

	"github.com/openhat/quick-start/internal/catalog"
	"github.com/openhat/quick-start/internal/planner"
)

func Needed(cat *catalog.Catalog, plan *planner.Plan) []catalog.Record {
	var out []catalog.Record
	seen := map[string]bool{}
	add := func(rec catalog.Record) {
		if rec.ID == "" || seen[rec.ID] {
			return
		}
		seen[rec.ID] = true
		out = append(out, rec)
	}
	if plan != nil {
		for _, s := range plan.Steps {
			for _, t := range s.Tools {
				add(t)
			}
			for _, c := range s.Commands {
				if strings.Contains(c, "SecLists") {
					if rec, ok := cat.ByID["seclists"]; ok {
						add(rec)
					}
				}
			}
		}
	}
	return out
}

func BinName(rec catalog.Record) string {
	if rec.Bin != "" {
		return rec.Bin
	}
	if rec.Kind == "guide" || rec.Build == "data" {
		return ""
	}
	if len(rec.Commands) == 0 {
		return rec.ID
	}
	fields := strings.Fields(rec.Commands[0])
	if len(fields) == 0 {
		return rec.ID
	}
	if fields[0] == "python" || fields[0] == "python3" || fields[0] == "py" {
		if len(fields) > 1 && !strings.HasPrefix(fields[1], "-") {
			return stripExt(filepath.Base(fields[1]))
		}
	}
	return filepath.Base(fields[0])
}

func stripExt(name string) string {
	for _, ext := range []string{".py", ".pl", ".rb", ".exe"} {
		name = strings.TrimSuffix(name, ext)
	}
	return name
}

func exeName(bin string) string {
	if runtime.GOOS == "windows" && !strings.HasSuffix(strings.ToLower(bin), ".exe") && !strings.Contains(bin, ".") {
		return bin + ".exe"
	}
	return bin
}

func SourceRel(rec catalog.Record) string {
	if rec.SubmodulePath != "" {
		return rec.SubmodulePath
	}
	if rec.Kind == "guide" {
		return filepath.Join("third-party-resources", "guides", rec.ID)
	}
	return filepath.Join("third-party-resources", "tools", rec.ID)
}

func GitURL(homepage string) string {
	homepage = strings.TrimSpace(homepage)
	if homepage == "" {
		return ""
	}
	if strings.HasSuffix(homepage, ".git") && (strings.Contains(homepage, "github.com") || strings.Contains(homepage, "gitlab.com")) {
		return homepage
	}
	for _, host := range []string{"https://github.com/", "https://gitlab.com/"} {
		if !strings.HasPrefix(homepage, host) {
			continue
		}
		rest := strings.TrimPrefix(homepage, host)
		parts := strings.Split(strings.Trim(rest, "/"), "/")
		if len(parts) >= 2 {
			return host + parts[0] + "/" + parts[1] + ".git"
		}
	}
	return ""
}
