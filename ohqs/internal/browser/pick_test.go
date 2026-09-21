package browser

import "testing"

func TestFamilyOf(t *testing.T) {
	if familyOf("firefox") != "firefox" || familyOf("waterfox") != "firefox" {
		t.Fatal("firefox family")
	}
	if familyOf("chrome") != "chromium" || familyOf("brave") != "chromium" {
		t.Fatal("chromium family")
	}
}

func TestPickFallsBackToFamily(t *testing.T) {
	found := []Found{
		{ID: "waterfox", Name: "Waterfox", Family: "firefox"},
		{ID: "chrome", Name: "Chrome", Family: "chromium"},
	}
	got, err := pickFrom("firefox", found)
	if err != nil || got.ID != "waterfox" {
		t.Fatalf("got %+v err %v", got, err)
	}
	got, err = pickFrom("chrome", found)
	if err != nil || got.ID != "chrome" {
		t.Fatalf("got %+v err %v", got, err)
	}
}
