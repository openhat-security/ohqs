package retrieve

import (
	"context"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/openhat/quick-start/internal/catalog"
	"github.com/openhat/quick-start/internal/index"
	"github.com/openhat/quick-start/internal/semantic"
)

func Situation(cat *catalog.Catalog, store *index.Store, situation string, limit int) []catalog.Record {
	if limit <= 0 {
		limit = 16
	}
	seen := map[string]int{}
	if store != nil {
		ids, err := store.Search(situation, limit*2)
		if err == nil {
			for i, id := range ids {
				seen[id] += (limit*2 - i)
			}
		}
	}
	q := strings.ToLower(situation)
	for _, r := range cat.Records {
		score := 0
		blob := strings.ToLower(r.SearchText())
		for _, w := range strings.Fields(q) {
			if len(w) < 3 {
				continue
			}
			if strings.Contains(blob, w) {
				score += 3
			}
			for _, t := range r.Tags {
				if strings.EqualFold(t, w) || strings.Contains(strings.ToLower(t), w) {
					score += 5
				}
			}
		}
		if strings.Contains(q, "ai") || strings.Contains(q, "vibe") || strings.Contains(q, "slop") || strings.Contains(q, "llm") {
			for _, t := range r.Tags {
				if t == "ai-slop" || t == "llm" || t == "sast" || t == "secrets" {
					score += 8
				}
			}
		}
		if strings.Contains(q, "clerk") || strings.Contains(q, "nextjs") || strings.Contains(q, "next.js") {
			for _, t := range r.Tags {
				if t == "clerk" || t == "nextjs" || t == "auth" || t == "authz" {
					score += 10
				}
			}
		}
		if score > 0 {
			seen[r.ID] += score
		}
	}
	type pair struct {
		id    string
		score int
	}
	var pairs []pair
	for id, sc := range seen {
		pairs = append(pairs, pair{id, sc})
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].score > pairs[j].score })
	var out []catalog.Record
	for _, p := range pairs {
		if rec, ok := cat.ByID[p.id]; ok {
			out = append(out, rec)
			if len(out) >= limit {
				break
			}
		}
	}
	return out
}

func Playbook(cat *catalog.Catalog, situation string) catalog.Playbook {
	if len(cat.Playbooks) == 0 {
		return catalog.Playbook{ID: "none", Title: "Ad hoc"}
	}
	q := strings.ToLower(situation)
	if strings.Contains(q, "clerk") {
		for _, pb := range cat.Playbooks {
			if pb.ID == "nextjs-clerk" {
				return pb
			}
		}
	}
	best := cat.Playbooks[0]
	bestScore := -1
	for _, pb := range cat.Playbooks {
		score := 0
		for _, m := range pb.Match {
			if strings.Contains(q, strings.ToLower(m)) {
				score++
			}
		}
		if score > bestScore {
			bestScore = score
			best = pb
		}
	}
	if bestScore <= 0 {
		for _, pb := range cat.Playbooks {
			if pb.ID == "bounty-web" {
				return pb
			}
		}
	}
	return best
}

// SituationRanked is the exploit-recommendation retrieval: it builds the
// lexical pool, then reranks it by cosine similarity against the persisted
// vector store (Situation with vectors present). On any embedder or vector
// failure it returns the lexical order. The returned string describes the rank
// source for display ("lexical", or "semantic (<embedder>)").
func SituationRanked(ctx context.Context, cat *catalog.Catalog, store *index.Store, situation string, limit int) ([]catalog.Record, string) {
	if limit <= 0 {
		limit = 16
	}
	if len(situation) < 2 {
		return Situation(cat, store, situation, limit), "lexical"
	}
	pool := Situation(cat, store, situation, max(limit*2, 4))
	if len(pool) < 2 || store == nil {
		return trim(pool, limit), "lexical"
	}
	has, err := store.HasVectors()
	if err != nil || !has {
		return trim(pool, limit), "lexical"
	}
	if ctx == nil {
		ctx = context.Background()
	}
	ectx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	e := semantic.Discover(ectx, os.Getenv("HF_TOKEN"))
	if e == nil {
		return trim(pool, limit), "lexical"
	}
	ids := make([]string, len(pool))
	for i, r := range pool {
		ids[i] = r.ID
	}
	ranked, rerr := store.SemanticFilter(ectx, e, situation, ids)
	if rerr != nil || len(ranked) == 0 {
		return trim(pool, limit), "lexical"
	}
	out := make([]catalog.Record, 0, len(ranked))
	byID := make(map[string]catalog.Record, len(pool))
	for _, r := range pool {
		byID[r.ID] = r
	}
	for _, id := range ranked {
		if r, ok := byID[id]; ok {
			out = append(out, r)
			if len(out) >= limit {
				break
			}
		}
	}
	return out, "semantic (" + e.Label() + ")"
}

func trim(recs []catalog.Record, n int) []catalog.Record {
	if len(recs) <= n {
		return recs
	}
	return recs[:n]
}
