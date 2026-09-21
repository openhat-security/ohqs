package retrieve

import (
	"testing"

	"github.com/openhat/quick-start/internal/catalog"
)

func TestPlaybookPrefersNextjsClerk(t *testing.T) {
	root, err := catalog.FindRoot("../..")
	if err != nil {
		t.Fatal(err)
	}
	cat, err := catalog.Load(root)
	if err != nil {
		t.Fatal(err)
	}
	pb := Playbook(cat, "vibe-coded Next.js SaaS with Clerk auth")
	if pb.ID != "nextjs-clerk" {
		t.Fatalf("playbook %s", pb.ID)
	}
}
