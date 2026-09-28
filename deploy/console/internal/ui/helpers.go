package ui

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/a-h/templ"
)

func joinLines(ss []string) string {
	return strings.Join(ss, "\n")
}

func filePayload(files []FileView) []map[string]any {
	out := make([]map[string]any, 0, len(files))
	for _, f := range files {
		out = append(out, map[string]any{
			"path":        f.Path,
			"content":     f.Content,
			"placeholder": f.Placeholder,
		})
	}
	return out
}

func creditsLabel(n int) string {
	if n == 1 {
		return "1 credit"
	}
	return fmt.Sprintf("%d credits", n)
}

func scaffoldLabel(v ResultView) string {
	if v.Mode != "code" {
		return "n/a"
	}
	if v.ScaffoldStatus == "" {
		return "?"
	}
	return v.ScaffoldStatus
}

func statusClass(s string) string {
	switch s {
	case "live":
		return "st-live"
	case "template", "stub":
		return "st-fallback"
	default:
		return ""
	}
}

// jsonScript emits <script type="application/json" id="...">...</script> with raw JSON.
func jsonScript(id string, v any) templ.Component {
	b, err := json.Marshal(v)
	if err != nil {
		b = []byte("null")
	}
	return templ.Raw(fmt.Sprintf(`<script type="application/json" id="%s">%s</script>`, id, string(b)))
}
