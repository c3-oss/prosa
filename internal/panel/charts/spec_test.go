package charts

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSpecJSONRoundTrips(t *testing.T) {
	s := Spec{
		Type:        "bar",
		Labels:      []string{"01-01", "01-08"},
		Datasets:    []Dataset{{Name: "claude", Values: []float64{3, 5}}},
		Stacked:     true,
		ValueSuffix: " sessions",
		Height:      180,
	}
	var got Spec
	if err := json.Unmarshal([]byte(s.JSON()), &got); err != nil {
		t.Fatalf("JSON() did not parse: %v", err)
	}
	if got.Type != "bar" || !got.Stacked || got.Height != 180 {
		t.Fatalf("round-trip lost fields: %+v", got)
	}
	if len(got.Datasets) != 1 || len(got.Datasets[0].Values) != len(s.Labels) {
		t.Fatalf("dataset/label mismatch: %+v", got.Datasets)
	}
}

// A "</script>" hiding in a label must not be able to close the JSON
// island; encoding/json escapes "<" to <.
func TestSpecJSONEscapesScriptClose(t *testing.T) {
	s := Spec{Type: "donut", Labels: []string{"</script><b>x"}, Datasets: []Dataset{{Values: []float64{1}}}}
	out := string(s.JSON())
	if strings.Contains(out, "</script>") || strings.Contains(out, "<b>") {
		t.Fatalf("unescaped markup leaked into island: %s", out)
	}
	var got Spec // still valid JSON after escaping
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("escaped JSON did not parse: %v", err)
	}
	if got.Labels[0] != "</script><b>x" {
		t.Fatalf("label corrupted by escaping: %q", got.Labels[0])
	}
}

func TestSpecHasData(t *testing.T) {
	if (Spec{}).HasData() {
		t.Fatal("empty spec reported HasData")
	}
	if (Spec{Datasets: []Dataset{{Values: nil}}}).HasData() {
		t.Fatal("empty-values dataset reported HasData")
	}
	if !(Spec{Datasets: []Dataset{{Values: []float64{1}}}}).HasData() {
		t.Fatal("non-empty dataset reported no data")
	}
}

// Omitempty keeps axis-only flags out of a donut spec and donut/pie-only
// shape out of axis charts, so the island stays minimal.
func TestSpecOmitsZeroFlags(t *testing.T) {
	out := string(Spec{Type: "line", Datasets: []Dataset{{Values: []float64{1}}}}.JSON())
	for _, k := range []string{"stacked", "regionFill", "valuePrefix", "valueSuffix"} {
		if strings.Contains(out, k) {
			t.Fatalf("zero field %q should have been omitted: %s", k, out)
		}
	}
}
