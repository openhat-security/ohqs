// Package d1seed writes a Cloudflare D1-compatible SQL seed from the local
// catalog + index: the full record JSON (so the edge can return the same
// catalog.Record shape), a separate FTS5 table, and the persisted float
// vectors as JSON arrays alongside their dimension.
package d1seed

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/openhat/quick-start/internal/catalog"
	"github.com/openhat/quick-start/internal/index"
)

// Schema creates the D1 tables. v=1 keeps the vector row as (id, dim, vec)
// where vec is a JSON array of floats; v=2 adds the full record JSON column.
const schemaSQL = `
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  name TEXT,
  kind TEXT,
  summary TEXT,
  tags TEXT,
  body TEXT,
  data TEXT
);
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS vectors (
  id TEXT PRIMARY KEY,
  dim INTEGER NOT NULL,
  vec TEXT NOT NULL
);
DROP TABLE IF EXISTS records_fts;
CREATE VIRTUAL TABLE records_fts USING fts5(id, name, kind, summary, tags, body);
`

// RecordBody mirrors index.recordBody: catalog fields + README snippet.
func RecordBody(cat *catalog.Catalog, r catalog.Record) string {
	body := r.SearchText()
	if snip := catalog.ReadmeSnippet(cat.Root, r.SubmodulePath, 3000); snip != "" {
		body += " " + snip
	}
	return body
}

// Seed writes a single self-contained SQL script: schema + deletes + inserts
// for records, FTS, metadata, and vectors (when the store has any). store may
// be nil; vectors are then omitted. No explicit BEGIN/COMMIT: `wrangler d1
// execute` wraps the file in a transaction and miniflare's local SQLite
// rejects hand-written transaction statements.
func Seed(w io.Writer, cat *catalog.Catalog, store *index.Store) error {
	if _, err := io.WriteString(w, schemaSQL); err != nil {
		return err
	}
	if _, err := io.WriteString(w, "DELETE FROM records;\nDELETE FROM metadata;\nDELETE FROM vectors;\n"); err != nil {
		return err
	}

	// Records.
	for _, r := range cat.Records {
		data, err := json.Marshal(r)
		if err != nil {
			return fmt.Errorf("record %s: %w", r.ID, err)
		}
		tags := strings.Join(r.Tags, " ")
		body := RecordBody(cat, r)
		line := fmt.Sprintf("INSERT INTO records(id,name,kind,summary,tags,body,data) VALUES (%s);\n",
			vals(sqlLit(r.ID), sqlLit(r.Name), sqlLit(r.Kind), sqlLit(r.Summary), sqlLit(tags), sqlLit(body), sqlLitBytes(data)))
		if _, err := io.WriteString(w, line); err != nil {
			return err
		}
	}
	if _, err := io.WriteString(w, "INSERT INTO records_fts(id,name,kind,summary,tags,body) SELECT id,name,kind,summary,tags,body FROM records;\n"); err != nil {
		return err
	}

	// Metadata.
	if store != nil {
		embedder, dim := store.VectorMeta()
		if embedder != "" {
			if _, err := io.WriteString(w, fmt.Sprintf("INSERT INTO metadata(key,value) VALUES ('vector_embedder',%s);\n", sqlLit(embedder))); err != nil {
				return err
			}
		}
		if dim > 0 {
			if _, err := io.WriteString(w, fmt.Sprintf("INSERT INTO metadata(key,value) VALUES ('vector_dim','%d');\n", dim)); err != nil {
				return err
			}
		}
	}

	// Vectors.
	if store != nil {
		if err := seedVectors(w, store); err != nil {
			return err
		}
	}

	return nil
}

func seedVectors(w io.Writer, st *index.Store) error {
	rows, err := st.DB.Query(`SELECT id, dim, vec FROM vectors`)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil
		}
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var dim int
		var blob []byte
		if err := rows.Scan(&id, &dim, &blob); err != nil {
			return err
		}
		vec, err := index.DecodeVector(blob, dim)
		if err != nil {
			return fmt.Errorf("vector %s: %w", id, err)
		}
		arr, err := json.Marshal(asF64(vec))
		if err != nil {
			return err
		}
		if _, err := fmt.Fprintf(w, "INSERT INTO vectors(id,dim,vec) VALUES (%s,%d,%s);\n", sqlLit(id), dim, sqlLitBytes(arr)); err != nil {
			return err
		}
	}
	return rows.Err()
}

func asF64(v []float32) []float64 {
	out := make([]float64, len(v))
	for i, x := range v {
		out[i] = float64(x)
	}
	return out
}

// vals formats n comma-joined SQL values.
func vals(parts ...string) string { return strings.Join(parts, ",") }

// sqlLit quotes a string as a SQLite literal (doubled single quotes).
func sqlLit(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

func sqlLitBytes(b []byte) string { return sqlLit(string(b)) }
