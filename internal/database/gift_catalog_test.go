package database

import "testing"

func TestDefaultSeckillMaterialCatalog(t *testing.T) {
	if len(defaultSeckillMaterialCatalog) != 1 {
		t.Fatalf("catalog size=%d, want=1", len(defaultSeckillMaterialCatalog))
	}

	material := defaultSeckillMaterialCatalog[0]
	if material.Id != StarMarrowMaterialID || material.Name != "星髓" {
		t.Fatalf("catalog material=%d/%s, want=4/星髓", material.Id, material.Name)
	}
	if material.Description == "" || material.Picture == "" || material.Price <= 0 || material.Count <= 0 {
		t.Fatalf("catalog material is incomplete: %+v", material)
	}

	current := append([]Gift(nil), defaultSeckillMaterialCatalog...)
	if !seckillMaterialCatalogMatches(current) {
		t.Fatal("canonical catalog should match itself")
	}
	current[0].Name = "旧材料"
	if seckillMaterialCatalogMatches(current) {
		t.Fatal("legacy prize catalog must trigger migration")
	}
}
