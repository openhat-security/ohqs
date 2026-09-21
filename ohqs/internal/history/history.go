package history

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

	"github.com/openhat/quick-start/internal/planner"
)

const (
	SourceCLI = "cli"
	SourceWeb = "web"
	SourceAPI = "api"
)

type Entry struct {
	ID            string          `json:"id"`
	Source        string          `json:"source"`
	Created       time.Time       `json:"created"`
	When          string          `json:"when"`
	Request       planner.Request `json:"request"`
	Playbook      string          `json:"playbook"`
	PlaybookTitle string          `json:"playbook_title"`
	Goal          string          `json:"goal"`
	Scope         string          `json:"scope"`
	Target        string          `json:"target"`
	Steps         int             `json:"steps"`
	Tools         []string        `json:"tools,omitempty"`
}

type Store struct {
	Dir string
}

func Open(dir string) *Store {
	return &Store{Dir: dir}
}

func (s *Store) Add(source string, req planner.Request, plan *planner.Plan) (*Entry, error) {
	if plan == nil {
		return nil, fmt.Errorf("no plan")
	}
	if err := os.MkdirAll(s.Dir, 0o755); err != nil {
		return nil, err
	}
	e := &Entry{
		ID:            newID(),
		Source:        source,
		Created:       time.Now().UTC(),
		Request:       req,
		Playbook:      plan.Playbook,
		PlaybookTitle: plan.PlaybookTitle,
		Goal:          plan.Goal,
		Scope:         plan.Scope,
		Target:        req.Target,
		Steps:         len(plan.Steps),
	}
	e.When = e.Created.Format("2006-01-02 15:04")
	seen := map[string]bool{}
	for _, st := range plan.Steps {
		for _, t := range st.Tools {
			if t.ID == "" || seen[t.ID] {
				continue
			}
			seen[t.ID] = true
			e.Tools = append(e.Tools, t.Name)
		}
	}
	b, err := json.MarshalIndent(e, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(s.Dir, e.ID+".json"), append(b, '\n'), 0o644); err != nil {
		return nil, err
	}
	return e, nil
}

func (s *Store) Get(id string) (*Entry, error) {
	if id == "" || strings.ContainsAny(id, `/\:`) || strings.Contains(id, "..") {
		return nil, fmt.Errorf("invalid history id")
	}
	b, err := os.ReadFile(filepath.Join(s.Dir, id+".json"))
	if err != nil {
		return nil, err
	}
	var e Entry
	if err := json.Unmarshal(b, &e); err != nil {
		return nil, err
	}
	if e.When == "" && !e.Created.IsZero() {
		e.When = e.Created.UTC().Format("2006-01-02 15:04")
	}
	return &e, nil
}

func (s *Store) List(limit int) []Entry {
	ents, err := os.ReadDir(s.Dir)
	if err != nil {
		return nil
	}
	var out []Entry
	for _, f := range ents {
		if f.IsDir() || !strings.HasSuffix(f.Name(), ".json") {
			continue
		}
		e, err := s.Get(strings.TrimSuffix(f.Name(), ".json"))
		if err != nil {
			continue
		}
		out = append(out, *e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created.After(out[j].Created) })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func newID() string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return time.Now().UTC().Format("20060102-150405") + "-" + hex.EncodeToString(b[:])
}
