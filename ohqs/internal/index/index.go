package index

import (
	"context"
	"database/sql"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/openhat/quick-start/internal/catalog"
	"github.com/openhat/quick-start/internal/semantic"
	_ "modernc.org/sqlite"
)

// ErrNoVectors is returned by semantic search when the index has no persisted
// vectors; callers fall back to the lexical FTS index.
var ErrNoVectors = errors.New("no vector embeddings in index (run: ohqs index --semantic)")

type Store struct {
	DB   *sql.DB
	Path string
}

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	s := &Store{DB: db, Path: path}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.DB.Close() }

// RecordCount is the number of catalog records currently indexed.
func (s *Store) RecordCount() (int, error) {
	var n int
	err := s.DB.QueryRow("SELECT COUNT(*) FROM records").Scan(&n)
	return n, err
}

// Fetch downloads a URL into dest, creating parent directories as needed. Used
// by `ohqs index download` and the browser UI's "Download release index".
func Fetch(url, dest string, timeout time.Duration) error {
	client := &http.Client{Timeout: timeout}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d from %s", resp.StatusCode, url)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, resp.Body); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// Vacuum compacts the database (VACUUM). Handy before shipping the index as a
// release asset. Encrypted/pages-cache DBs are not touched.
func (s *Store) Vacuum() error {
	_, err := s.DB.Exec("VACUUM")
	return err
}

func (s *Store) migrate() error {
	_, err := s.DB.Exec(`
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  name TEXT,
  kind TEXT,
  summary TEXT,
  tags TEXT,
  body TEXT
);
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT
);
`)
	if err != nil {
		return err
	}
	_, err = s.DB.Exec(`
CREATE TABLE IF NOT EXISTS vectors (
  id TEXT PRIMARY KEY,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL
);
`)
	return err
}

func (s *Store) Rebuild(cat *catalog.Catalog) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(`DROP TABLE IF EXISTS records_fts`); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM records`); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM metadata`); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM vectors`); err != nil {
		return err
	}
	if _, err := tx.Exec(`CREATE VIRTUAL TABLE records_fts USING fts5(id, name, kind, summary, tags, body)`); err != nil {
		return err
	}

	ins, err := tx.Prepare(`INSERT INTO records(id, name, kind, summary, tags, body) VALUES (?,?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer ins.Close()
	fts, err := tx.Prepare(`INSERT INTO records_fts(id, name, kind, summary, tags, body) VALUES (?,?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer fts.Close()

	for _, r := range cat.Records {
		body := recordBody(cat, r)
		tags := strings.Join(r.Tags, " ")
		if _, err := ins.Exec(r.ID, r.Name, r.Kind, r.Summary, tags, body); err != nil {
			return err
		}
		if _, err := fts.Exec(r.ID, r.Name, r.Kind, r.Summary, tags, body); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// recordBody is the searchable blob stored in the FTS index and embedded into
// the vector store: catalog fields + tags/vuln classes + README snippet.
func recordBody(cat *catalog.Catalog, r catalog.Record) string {
	body := r.SearchText()
	if snip := catalog.ReadmeSnippet(cat.Root, r.SubmodulePath, 3000); snip != "" {
		body += " " + snip
	}
	return body
}

func (s *Store) Search(query string, limit int) ([]string, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("empty query")
	}
	if limit <= 0 {
		limit = 20
	}
	need := significantTokens(query)
	if len(need) == 0 {
		return nil, nil
	}
	strict := strings.Join(need, " AND ")
	ids, err := s.matchRecords(strict, limit)
	if err != nil {
		return nil, err
	}
	if len(ids) > 0 {
		return ids, nil
	}
	// Nothing matched every term together; relax to OR so partial matches still surface.
	return s.matchRecords(strings.Join(need, " OR "), limit)
}

// significantTokens drops FTS noise words and re-quotes nothing: each token is
// prefixed-stemmed so "command control" still finds "commands" and "controlled".
func significantTokens(q string) []string {
	var out []string
	for _, p := range strings.Fields(q) {
		p = strings.Trim(strings.ToLower(p), `"(),'`)
		if p == "" || isFTSStopword(p) {
			continue
		}
		out = append(out, p+"*")
	}
	return out
}

func isFTSStopword(w string) bool {
	switch w {
	case "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in",
		"is", "it", "of", "on", "or", "the", "to", "what", "when", "where",
		"which", "who", "will", "with", "vs", "i", "you":
		return true
	}
	return false
}

func (s *Store) matchRecords(ftsQ string, limit int) ([]string, error) {
	rows, err := s.DB.Query(`SELECT id FROM records_fts WHERE records_fts MATCH ? ORDER BY rank LIMIT ?`, ftsQ, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// HasVectors reports whether persisted embeddings exist for this index.
// Check before SemanticFilter so callers can decide on the fly.
func (s *Store) HasVectors() (bool, error) {
	var n int
	err := s.DB.QueryRow(`SELECT COUNT(*) FROM vectors`).Scan(&n)
	return n > 0, err
}

// VectorMeta returns the embedder label and vector dimensionality recorded
// when the embeddings were built.
func (s *Store) VectorMeta() (embedder string, dim int) {
	_ = s.DB.QueryRow(`SELECT value FROM metadata WHERE key = 'vector_embedder'`).Scan(&embedder)
	_ = s.DB.QueryRow(`SELECT CAST(value AS INTEGER) FROM metadata WHERE key = 'vector_dim'`).Scan(&dim)
	return embedder, dim
}

const (
	MetaKeyEmbedder = "vector_embedder"
	MetaKeyDim      = "vector_dim"
)

// EmbedRecords embeds every catalog record body and persists L2-normalized
// vectors plus metadata. A nil embedder clears vectors and returns ErrNoVectors
// semantics so the caller can report a lexical-only build.
func (s *Store) EmbedRecords(ctx context.Context, cat *catalog.Catalog, e semantic.Embedder) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if e == nil {
		if _, err := s.DB.Exec(`DELETE FROM vectors`); err != nil {
			return err
		}
		if _, err := s.DB.Exec(`DELETE FROM metadata WHERE key IN (?, ?)`, MetaKeyEmbedder, MetaKeyDim); err != nil {
			return err
		}
		return ErrNoVectors
	}
	docTexts := make([]string, len(cat.Records))
	for i, r := range cat.Records {
		docTexts[i] = recordBody(cat, r)
	}
	vecs, err := e.Embed(ctx, docTexts)
	if err != nil {
		return fmt.Errorf("embed %d records: %w", len(docTexts), err)
	}
	if len(vecs) != len(docTexts) {
		return fmt.Errorf("embed: got %d vectors for %d records", len(vecs), len(docTexts))
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM vectors`); err != nil {
		return err
	}
	ins, err := tx.Prepare(`INSERT OR REPLACE INTO vectors(id, dim, vec) VALUES (?,?,?)`)
	if err != nil {
		return err
	}
	defer ins.Close()
	dim := len(vecs[0])
	for i, v := range vecs {
		if len(v) == 0 {
			return fmt.Errorf("embed: empty vector for %s", cat.Records[i].ID)
		}
		if len(v) != dim {
			return fmt.Errorf("embed: dim %d for %s, want %d", len(v), cat.Records[i].ID, dim)
		}
		if _, err := ins.Exec(cat.Records[i].ID, dim, EncodeVector(semantic.Normalize(v))); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`INSERT OR REPLACE INTO metadata(key, value) VALUES (?,?)`, MetaKeyEmbedder, e.Label()); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT OR REPLACE INTO metadata(key, value) VALUES (?,?)`, MetaKeyDim, fmt.Sprintf("%d", dim)); err != nil {
		return err
	}
	return tx.Commit()
}

// SemanticFilter sorts the given ids by cosine similarity of the query's
// embedding against the persisted vectors, most similar first. The caller
// passes the same embedder family used to build the index (nil means no
// semantic rank). Stored vectors are normalized, so similarity reduces to a
// dot product. Returns ErrNoVectors when none exist.
func (s *Store) SemanticFilter(ctx context.Context, e semantic.Embedder, query string, ids []string) ([]string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	query = strings.TrimSpace(query)
	if e == nil {
		return nil, ErrNoVectors
	}
	if query == "" || len(ids) < 2 {
		return ids, nil
	}
	dim, err := s.vectorDim()
	if err != nil {
		return nil, err
	}
	if dim <= 0 {
		return nil, ErrNoVectors
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	rows, err := s.DB.QueryContext(ctx, `SELECT id, vec FROM vectors WHERE id IN (`+placeholders+`)`, strArgs(ids)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	docs := make(map[string][]float32, len(ids))
	for rows.Next() {
		var id string
		var blob []byte
		if err := rows.Scan(&id, &blob); err != nil {
			return nil, err
		}
		v, err := DecodeVector(blob, dim)
		if err != nil {
			return nil, err
		}
		docs[id] = v
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(docs) == 0 {
		return nil, ErrNoVectors
	}
	vecs, err := e.Embed(ctx, []string{query})
	if err != nil {
		return nil, err
	}
	if len(vecs) == 0 || len(vecs[0]) == 0 {
		return nil, fmt.Errorf("embed: empty query vector")
	}
	q := vecs[0]
	if len(q) != dim {
		return nil, fmt.Errorf("query vector dim %d, index dim %d", len(q), dim)
	}
	type scored struct {
		id    string
		score float64
	}
	out := make([]scored, 0, len(ids))
	for _, id := range ids {
		v, ok := docs[id]
		if !ok {
			continue
		}
		out = append(out, scored{id: id, score: dot(q, v)})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].score > out[j].score })
	res := make([]string, len(out))
	for i, s := range out {
		res[i] = s.id
	}
	return res, nil
}

func (s *Store) vectorDim() (int, error) {
	var null sql.NullInt64
	err := s.DB.QueryRow(`SELECT value FROM metadata WHERE key = ?`, MetaKeyDim).Scan(&null)
	if err == sql.ErrNoRows || !null.Valid {
		var dim int
		row := s.DB.QueryRow(`SELECT dim FROM vectors LIMIT 1`)
		if err := row.Scan(&dim); err != nil {
			return 0, ErrNoVectors
		}
		return dim, nil
	}
	return int(null.Int64), err
}

func dot(a, b []float32) float64 {
	var sum float64
	for i := range a {
		sum += float64(a[i]) * float64(b[i])
	}
	return sum
}

// EncodeVector packs float32s little-endian into a BLOB.
func EncodeVector(v []float32) []byte {
	out := make([]byte, 4*len(v))
	for i, x := range v {
		binary.LittleEndian.PutUint32(out[i*4:], math.Float32bits(x))
	}
	return out
}

// DecodeVector unpacks a BLOB of little-endian float32s.
func DecodeVector(b []byte, dim int) ([]float32, error) {
	if len(b) != 4*dim {
		return nil, fmt.Errorf("vector blob %d bytes, want %d", len(b), 4*dim)
	}
	v := make([]float32, dim)
	for i := range v {
		v[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
	}
	return v, nil
}

func strArgs(ids []string) []any {
	out := make([]any, len(ids))
	for i, id := range ids {
		out[i] = id
	}
	return out
}
