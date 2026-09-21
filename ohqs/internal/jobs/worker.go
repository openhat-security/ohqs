package jobs

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/openhat/quick-start/internal/catalog"
	"github.com/openhat/quick-start/internal/deps"
	"github.com/openhat/quick-start/internal/index"
	"github.com/openhat/quick-start/internal/planner"
	"github.com/openhat/quick-start/internal/selfinstall"
)

func (s *Store) Work(id string) error {
	m, err := s.Load(id)
	if err != nil {
		return err
	}
	m.PID = os.Getpid()
	m.Status = StatusRunning
	m.Error = ""
	if err := s.save(m); err != nil {
		return err
	}
	s.AppendLog(id, fmt.Sprintf("=== %s job %s pid %d ===\n", m.Type, id, m.PID))

	var workErr error
	switch m.Type {
	case TypeInstall:
		workErr = s.workInstall(m)
	case TypeRun:
		workErr = s.workRun(m)
	default:
		workErr = fmt.Errorf("unknown job type %s", m.Type)
	}

	m, _ = s.Load(id)
	if m == nil {
		return workErr
	}
	if workErr != nil {
		m.Status = StatusFailed
		m.Error = workErr.Error()
		s.AppendLog(id, "FAILED: "+workErr.Error()+"\n")
	} else if m.Status != StatusStopped {
		m.Status = StatusDone
		s.AppendLog(id, "=== done ===\n")
	}
	return s.save(m)
}

func (s *Store) workInstall(m *Meta) error {
	cat, err := catalog.Load(s.Root)
	if err != nil {
		return err
	}
	var store *index.Store
	idx := filepath.Join(s.Root, "data", "ohqs.sqlite")
	if _, err := os.Stat(idx); err == nil {
		store, _ = index.Open(idx)
		if store != nil {
			defer store.Close()
		}
	}
	plan, err := planner.Build(cat, store, m.Request)
	if err != nil {
		return err
	}
	if len(m.Packages) == 0 {
		if err := s.SeedInstall(m.ID, deps.Check(s.Root, cat, plan)); err != nil {
			return err
		}
		m, err = s.Load(m.ID)
		if err != nil {
			return err
		}
	}
	logf, err := os.OpenFile(filepath.Join(s.path(m.ID), "output.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer logf.Close()

	for i := range m.Packages {
		cur, err := s.Load(m.ID)
		if err != nil {
			return err
		}
		if cur.Status == StatusStopped {
			return nil
		}
		m = cur
		pkg := &m.Packages[i]
		if pkg.Status != deps.StatusMissing && pkg.Status != "pending" && pkg.Status != "current" && pkg.Status != deps.StatusFailed {
			continue
		}
		rec, ok := cat.ByID[pkg.ID]
		if !ok {
			pkg.Status = deps.StatusSkipped
			s.refreshInstallETA(m)
			_ = s.save(m)
			continue
		}
		pkg.Status = "current"
		m.Current = pkg.Name
		s.refreshInstallETA(m)
		_ = s.save(m)
		s.AppendLog(m.ID, fmt.Sprintf("\n>> %s\n", pkg.Name))
		t0 := time.Now()
		item := deps.ApplyOne(s.Root, rec, logf)
		elapsed := time.Since(t0).Milliseconds()
		pkg.Status = item.Status
		if item.Note != "" {
			s.AppendLog(m.ID, item.Note+"\n")
		}
		if item.Status == deps.StatusBuilt || item.Status == deps.StatusFetched {
			m.WorkMS = append(m.WorkMS, elapsed)
		}
		m.Current = ""
		s.refreshInstallETA(m)
		_ = s.save(m)
		if item.Status == deps.StatusFailed {
			return fmt.Errorf("%s: %s", item.ID, item.Note)
		}
	}
	m.Current = ""
	m.Remaining = nil
	m.ETAText, m.Beer = FunnyETA(0, 0)
	_ = s.save(m)
	_, _ = logf.WriteString(deps.Format(deps.Check(s.Root, cat, plan)))
	return nil
}

func (s *Store) workRun(m *Meta) error {
	pathEnv := selfinstall.PathEnv(s.Root)
	if err := ensureOutDirs(s.Root, m.Commands); err != nil {
		return err
	}
	for i := m.Completed; i < len(m.Commands); i++ {
		cur, err := s.Load(m.ID)
		if err != nil {
			return err
		}
		if cur.Status == StatusStopped {
			return nil
		}
		c := m.Commands[i]
		s.AppendLog(m.ID, fmt.Sprintf("\n--- %d. %s ---\n", c.N, c.Title))
		if c.Skip != "" {
			s.AppendLog(m.ID, "# skip: "+c.Cmd+"\n# "+c.Skip+"\n")
			m.Completed = i + 1
			_ = s.save(m)
			continue
		}
		s.AppendLog(m.ID, "$ "+c.Cmd+"\n")
		cmd := shellCommand(c.Cmd)
		cmd.Dir = s.Root
		cmd.Env = append(os.Environ(), "PATH="+pathEnv)
		logf, err := os.OpenFile(filepath.Join(s.path(m.ID), "output.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			return err
		}
		cmd.Stdout = logf
		cmd.Stderr = logf
		err = cmd.Run()
		_ = logf.Close()
		if err != nil {
			m.Completed = i
			_ = s.save(m)
			return fmt.Errorf("step %d (%s): %w", c.N, c.Title, err)
		}
		m.Completed = i + 1
		m.Updated = time.Now().UTC()
		_ = s.save(m)
	}
	return nil
}

func shellCommand(cmdline string) *exec.Cmd {
	if runtime.GOOS == "windows" {
		return exec.Command("cmd", "/C", cmdline)
	}
	// Non-login: keep PATH from the job (bin/ + bin/tools + Go bin).
	// bash -l overwrites PATH from a bash profile and loses ohqs.
	return exec.Command("bash", "-c", cmdline)
}

func ensureOutDirs(root string, cmds []Command) error {
	seen := map[string]bool{}
	add := func(dir string) error {
		if dir == "" || dir == "." {
			return nil
		}
		if !filepath.IsAbs(dir) {
			dir = filepath.Join(root, dir)
		}
		dir = filepath.Clean(dir)
		if seen[dir] {
			return nil
		}
		seen[dir] = true
		return os.MkdirAll(dir, 0o755)
	}
	if err := add("evidence"); err != nil {
		return err
	}
	for _, c := range cmds {
		for _, dir := range parentOutDirs(c.Cmd) {
			if err := add(dir); err != nil {
				return err
			}
		}
	}
	return nil
}

func parentOutDirs(cmd string) []string {
	fields := strings.Fields(cmd)
	var dirs []string
	take := func(p string) {
		p = strings.Trim(p, `"'`)
		if p == "" || strings.HasPrefix(p, "-") || strings.Contains(p, "://") {
			return
		}
		d := filepath.Dir(p)
		if d != "" && d != "." {
			dirs = append(dirs, d)
		}
	}
	for i, f := range fields {
		name, val, ok := strings.Cut(f, "=")
		if ok {
			switch name {
			case "--report-path", "-o", "-oA", "--output":
				take(val)
			}
			continue
		}
		switch f {
		case "--report-path", "-o", "-oA", "--output":
			if i+1 < len(fields) {
				take(fields[i+1])
			}
		}
	}
	return dirs
}
