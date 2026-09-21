package jobs

import "testing"

func TestFunnyETABeer(t *testing.T) {
	text, beer := FunnyETA(6, 30)
	if !beer {
		t.Fatal("six packages should be a beer")
	}
	if text == "" {
		t.Fatal("empty")
	}
	_, beer = FunnyETA(1, 20)
	if beer {
		t.Fatal("one quick package is not a beer")
	}
	text, beer = FunnyETA(0, 0)
	if beer || text == "" {
		t.Fatalf("%q %v", text, beer)
	}
}
