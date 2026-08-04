package database

import "testing"

func TestDefaultSeckillMaterialCatalog(t *testing.T) {
	wantNames := []string{"月盐", "雾银", "龙息琥珀", "星髓"}
	if len(defaultSeckillMaterialCatalog) != len(wantNames) {
		t.Fatalf("catalog size=%d, want=%d", len(defaultSeckillMaterialCatalog), len(wantNames))
	}

	for i, wantName := range wantNames {
		material := defaultSeckillMaterialCatalog[i]
		if material.Id != i+1 || material.Name != wantName {
			t.Fatalf("catalog[%d]=%d/%s, want=%d/%s", i, material.Id, material.Name, i+1, wantName)
		}
		if material.Description == "" || material.Picture == "" || material.Price <= 0 || material.Count <= 0 {
			t.Fatalf("catalog material is incomplete: %+v", material)
		}
	}

	current := append([]Gift(nil), defaultSeckillMaterialCatalog...)
	if !seckillMaterialCatalogMatches(current) {
		t.Fatal("canonical catalog should match itself")
	}
	current[0].Name = "谢谢参与"
	if seckillMaterialCatalogMatches(current) {
		t.Fatal("legacy prize catalog must trigger migration")
	}
}
