package deps

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/openhat/quick-start/internal/catalog"
	"github.com/openhat/quick-start/internal/planner"
)

const (
	StatusPresent = "present"
	StatusMissing = "missing"
	StatusBuilt   = "built"
	StatusFetched = "fetched"
	StatusSkipped = "skipped"
	StatusFailed  = "failed"
)

type Item struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Bin    string `json:"bin,omitempty"`
	Status string `json:"status"`
	Where  string `json:"where,omitempty"`
	Note   string `json:"note,omitempty"`
}

type Report struct {
	Host  Host   `json:"host"`
	Items []Item `json:"items"`
}

func Check(root string, cat *catalog.Catalog, plan *planner.Plan) Report {
	return run(root, cat, plan, false, io.Discard)
}

func Install(root string, cat *catalog.Catalog, plan *planner.Plan, out io.Writer) Report {
	if out == nil {
		out = io.Discard
	}
	return run(root, cat, plan, true, out)
}

func ApplyOne(root string, rec catalog.Record, out io.Writer) Item {
	if out == nil {
		out = io.Discard
	}
	host := Detect(root)
	_ = os.MkdirAll(host.Prefix, 0o755)
	pathEnv := host.Prefix + string(os.PathListSeparator) + os.Getenv("PATH")
	return ensure(root, rec, host, pathEnv, true, out)
}

func run(root string, cat *catalog.Catalog, plan *planner.Plan, apply bool, out io.Writer) Report {
	host := Detect(root)
	_ = os.MkdirAll(host.Prefix, 0o755)
	rep := Report{Host: host}
	pathEnv := host.Prefix + string(os.PathListSeparator) + os.Getenv("PATH")

	for _, rec := range Needed(cat, plan) {
		item := ensure(root, rec, host, pathEnv, apply, out)
		rep.Items = append(rep.Items, item)
	}
	return rep
}

func ensure(root string, rec catalog.Record, host Host, pathEnv string, apply bool, out io.Writer) Item {
	item := Item{ID: rec.ID, Name: rec.Name, Bin: BinName(rec)}
	if rec.Kind == "extension" || rec.Kind == "os" || rec.Kind == "platform" {
		item.Status = StatusSkipped
		if rec.Kind == "extension" {
			item.Note = "browser extension — pre-installed by ohqs browser"
		} else {
			item.Note = "not a CLI tool — install from the catalog homepage if you need it"
		}
		return item
	}
	if !host.Supported(rec.Platforms) {
		item.Status = StatusSkipped
		item.Note = "not listed for " + host.Name
		return item
	}
	if rec.Build == "manual" {
		if p := look(item.Bin, pathEnv); p != "" {
			item.Status = StatusPresent
			item.Where = p
			return item
		}
		item.Status = StatusSkipped
		item.Note = manualNote(host, rec)
		return item
	}
	if item.Bin != "" {
		if p := look(item.Bin, pathEnv); p != "" {
			item.Status = StatusPresent
			item.Where = p
			return item
		}
	}
	if rec.Build == "data" || rec.Kind == "guide" {
		src := filepath.Join(root, SourceRel(rec))
		if sourceReady(src) {
			item.Status = StatusPresent
			item.Where = SourceRel(rec)
			return item
		}
		if !apply {
			item.Status = StatusMissing
			item.Note = "will shallow-clone into " + SourceRel(rec)
			return item
		}
		fmt.Fprintf(out, "%s (wordlists)\n", rec.Name)
		if err := fetch(root, rec, out); err != nil {
			item.Status = StatusFailed
			item.Note = err.Error()
			return item
		}
		item.Status = StatusFetched
		item.Where = SourceRel(rec)
		return item
	}
	if !apply {
		item.Status = StatusMissing
		src := filepath.Join(root, SourceRel(rec))
		if sourceReady(src) {
			item.Note = "source present, will build into " + host.Prefix
		} else {
			item.Note = "will shallow-clone + build into " + host.Prefix
		}
		return item
	}
	fmt.Fprintf(out, "%s\n", rec.Name)
	if err := fetch(root, rec, out); err != nil {
		item.Status = StatusFailed
		item.Note = err.Error()
		return item
	}
	if err := os.MkdirAll(host.Prefix, 0o755); err != nil {
		item.Status = StatusFailed
		item.Note = err.Error()
		return item
	}
	if err := buildFromSource(root, rec, host, out); err != nil {
		item.Status = StatusFailed
		item.Note = err.Error()
		return item
	}
	if p := look(item.Bin, pathEnv); p != "" {
		item.Status = StatusBuilt
		item.Where = p
		return item
	}
	item.Status = StatusBuilt
	item.Where = filepath.Join(host.Prefix, exeName(item.Bin))
	return item
}

func look(bin, pathEnv string) string {
	if bin == "" {
		return ""
	}
	if runtimeIsWindows() {
		if p, err := lookPathEnv(bin+".cmd", pathEnv); err == nil {
			return p
		}
		if p, err := lookPathEnv(bin+".exe", pathEnv); err == nil {
			return p
		}
	}
	p, err := lookPathEnv(bin, pathEnv)
	if err != nil {
		return ""
	}
	return p
}

func lookPathEnv(name, pathEnv string) (string, error) {
	old := os.Getenv("PATH")
	_ = os.Setenv("PATH", pathEnv)
	defer os.Setenv("PATH", old)
	return exec.LookPath(name)
}

func runtimeIsWindows() bool {
	return os.PathListSeparator == ';'
}

func manualNote(host Host, rec catalog.Record) string {
	if rec.Install != "" {
		return rec.Install
	}
	switch host.GOOS {
	case "darwin":
		return "install via Homebrew or the project site — ohqs will not auto-build this"
	case "windows":
		return "install from the project site — ohqs will not auto-build this"
	default:
		return "install via your package manager or the project site — ohqs will not auto-build this"
	}
}

func Format(r Report) string {
	var b strings.Builder
	fmt.Fprintf(&b, "host     %s (%s/%s)\n", r.Host.Name, r.Host.GOOS, r.Host.GOARCH)
	if r.Host.Distro != "" {
		fmt.Fprintf(&b, "distro   %s\n", r.Host.Distro)
	}
	fmt.Fprintf(&b, "prefix   %s\n", r.Host.Prefix)
	fmt.Fprintf(&b, "git      %s\n", orMissing(r.Host.Git))
	fmt.Fprintf(&b, "go       %s\n", orMissing(r.Host.Go))
	fmt.Fprintf(&b, "cargo    %s\n", orMissing(r.Host.Cargo))
	fmt.Fprintf(&b, "python3  %s\n", orMissing(r.Host.Python3))
	if len(r.Items) == 0 {
		b.WriteString("\nno plan tools to check\n")
		return b.String()
	}
	b.WriteString("\n")
	for _, it := range r.Items {
		line := fmt.Sprintf("%-10s  %-16s", it.Status, it.ID)
		if it.Where != "" {
			line += "  " + it.Where
		}
		if it.Note != "" {
			line += "  " + it.Note
		}
		b.WriteString(line + "\n")
	}
	b.WriteString("\nOnly missing plan tools are cloned (shallow) into third-party-resources/ and built into bin/tools.\n")
	b.WriteString("Add bin/tools to PATH. ohqs does not generate exploits.\n")
	return b.String()
}

func orMissing(s string) string {
	if s == "" {
		return "missing"
	}
	return s
}
