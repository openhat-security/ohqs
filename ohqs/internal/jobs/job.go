package jobs

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/openhat/quick-start/internal/deps"
	"github.com/openhat/quick-start/internal/planner"
)

const (
	TypeInstall = "install"
	TypeRun     = "run"

	StatusQueued      = "queued"
	StatusRunning     = "running"
	StatusDone        = "done"
	StatusFailed      = "failed"
	StatusStopped     = "stopped"
	StatusInterrupted = "interrupted"
)

type Request = planner.Request

type Command struct {
	N     int    `json:"n"`
	Title string `json:"title"`
	Cmd   string `json:"cmd"`
	Skip  string `json:"skip,omitempty"`
}

type Pkg struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

type Meta struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	Status    string    `json:"status"`
	PID       int       `json:"pid,omitempty"`
	Goal      string    `json:"goal"`
	Scope     string    `json:"scope"`
	Playbook  string    `json:"playbook"`
	Request   Request   `json:"request"`
	Commands  []Command `json:"commands,omitempty"`
	Packages  []Pkg     `json:"packages,omitempty"`
	Current   string    `json:"current,omitempty"`
	Remaining []string  `json:"remaining,omitempty"`
	ETAText   string    `json:"eta_text,omitempty"`
	Beer      bool      `json:"beer,omitempty"`
	WorkMS    []int64   `json:"work_ms,omitempty"`
	Completed int       `json:"completed"`
	Total     int       `json:"total"`
	Error     string    `json:"error,omitempty"`
	Created   time.Time `json:"created"`
	Updated   time.Time `json:"updated"`
}

type View struct {
	Meta
	Log     string `json:"log"`
	LogPath string `json:"log_path"`
	Alive   bool   `json:"alive"`
}

type Store struct {
	Root string
	Dir  string
}

func Open(root, dir string) *Store {
	return &Store{Root: root, Dir: dir}
}

func (s *Store) path(id string) string {
	return filepath.Join(s.Dir, id)
}

func newID() string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return time.Now().UTC().Format("20060102-150405") + "-" + hex.EncodeToString(b[:])
}

func CommandsFromPlan(p *planner.Plan) []Command {
	var out []Command
	for _, st := range p.Steps {
		for _, c := range st.Commands {
			item := Command{N: st.N, Title: st.Title, Cmd: c}
			if why := skipReason(c); why != "" {
				item.Skip = why
			}
			out = append(out, item)
		}
	}
	return out
}

func skipReason(cmd string) string {
	trim := strings.TrimSpace(cmd)
	if trim == "" {
		return "empty"
	}
	if strings.HasPrefix(trim, "#") {
		return "comment — run this yourself if you need it"
	}
	return interactiveReason(cmd)
}

func interactiveReason(cmd string) string {
	fields := strings.Fields(cmd)
	if len(fields) == 0 {
		return "empty"
	}
	bin := filepath.Base(fields[0])
	switch strings.ToLower(bin) {
	case "zap.sh", "zap.bat", "zap", "zaproxy", "mitmproxy", "mitmweb", "burp", "burpsuite":
		return "interactive proxy — run this yourself"
	}
	return ""
}

func (s *Store) Create(kind string, req Request, plan *planner.Plan) (*Meta, error) {
	if err := os.MkdirAll(s.Dir, 0o755); err != nil {
		return nil, err
	}
	id := newID()
	dir := s.path(id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	m := &Meta{
		ID:       id,
		Type:     kind,
		Status:   StatusQueued,
		Goal:     plan.Goal,
		Scope:    plan.Scope,
		Playbook: plan.Playbook,
		Request:  req,
		Created:  time.Now().UTC(),
		Updated:  time.Now().UTC(),
	}
	if kind == TypeRun {
		m.Commands = CommandsFromPlan(plan)
		m.Total = len(m.Commands)
	}
	if err := s.save(m); err != nil {
		return nil, err
	}
	if _, err := os.OpenFile(filepath.Join(dir, "output.log"), os.O_CREATE, 0o644); err != nil {
		return nil, err
	}
	return m, nil
}

func (s *Store) SeedInstall(id string, rep deps.Report) error {
	m, err := s.Load(id)
	if err != nil {
		return err
	}
	m.Packages = nil
	m.Remaining = nil
	m.Completed = 0
	for _, it := range rep.Items {
		m.Packages = append(m.Packages, Pkg{ID: it.ID, Name: it.Name, Status: it.Status})
		if it.Status == deps.StatusMissing {
			m.Remaining = append(m.Remaining, it.Name)
		}
	}
	m.Total = len(m.Remaining)
	m.ETAText, m.Beer = FunnyETA(len(m.Remaining), estimateSec(len(m.Remaining), nil))
	return s.save(m)
}

func (s *Store) refreshInstallETA(m *Meta) {
	var rem []string
	done := 0
	for _, p := range m.Packages {
		switch p.Status {
		case deps.StatusMissing, "pending", "current":
			rem = append(rem, p.Name)
		case deps.StatusBuilt, deps.StatusFetched, deps.StatusPresent:
			done++
		}
	}
	m.Remaining = rem
	m.Completed = done
	m.Total = done + len(rem)
	m.ETAText, m.Beer = FunnyETA(len(rem), estimateSec(len(rem), m.WorkMS))
}

func (s *Store) save(m *Meta) error {
	m.Updated = time.Now().UTC()
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.path(m.ID), "meta.json"), append(b, '\n'), 0o644)
}

func (s *Store) Load(id string) (*Meta, error) {
	if id == "" || strings.Contains(id, "/") || strings.Contains(id, "\\") || strings.Contains(id, "..") {
		return nil, fmt.Errorf("invalid job id")
	}
	b, err := os.ReadFile(filepath.Join(s.path(id), "meta.json"))
	if err != nil {
		return nil, err
	}
	var m Meta
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	s.Reconcile(&m)
	return &m, nil
}

func (s *Store) Reconcile(m *Meta) {
	if m.Status != StatusRunning {
		return
	}
	if m.PID == 0 || !pidAlive(m.PID) {
		m.Status = StatusInterrupted
		m.Error = "worker is not running — Resume to continue"
		_ = s.save(m)
	}
}

func (s *Store) List(limit int) []Meta {
	ents, err := os.ReadDir(s.Dir)
	if err != nil {
		return nil
	}
	var out []Meta
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		m, err := s.Load(e.Name())
		if err != nil {
			continue
		}
		out = append(out, *m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func (s *Store) View(id string, logMax int) (*View, error) {
	m, err := s.Load(id)
	if err != nil {
		return nil, err
	}
	logPath := filepath.Join(s.path(id), "output.log")
	logb, _ := tailFile(logPath, logMax)
	return &View{
		Meta:    *m,
		Log:     string(logb),
		LogPath: logPath,
		Alive:   m.PID != 0 && pidAlive(m.PID),
	}, nil
}

func (s *Store) AppendLog(id, line string) {
	f, err := os.OpenFile(filepath.Join(s.path(id), "output.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(line)
	if !strings.HasSuffix(line, "\n") {
		_, _ = f.WriteString("\n")
	}
}

func tailFile(path string, max int) ([]byte, error) {
	if max <= 0 {
		max = 64 << 10
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(b) > max {
		return b[len(b)-max:], nil
	}
	return b, nil
}
