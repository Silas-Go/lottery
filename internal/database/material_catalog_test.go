package database

import "testing"

func TestDefaultMaterialCatalogOnlyExposesStarMarrow(t *testing.T) {
	if len(defaultMaterialCatalog) != 1 {
		t.Fatalf("primary material count=%d, want=1", len(defaultMaterialCatalog))
	}
	material := defaultMaterialCatalog[0]
	if material.ID != starMarrowMaterialID || material.Code != "star-marrow" || material.Name != "星髓" || !material.IsPrimary {
		t.Fatalf("unexpected primary material: %+v", material)
	}

	wantComponents := map[int]bool{401: true, 402: true, 403: true}
	if len(defaultComponentMaterials) != len(wantComponents) || len(defaultMaterialComponents) != len(wantComponents) {
		t.Fatalf("component fixture size materials=%d relations=%d, want=%d",
			len(defaultComponentMaterials), len(defaultMaterialComponents), len(wantComponents))
	}
	for _, relation := range defaultMaterialComponents {
		if relation.MaterialID != starMarrowMaterialID || !wantComponents[relation.ComponentMaterialID] {
			t.Fatalf("unexpected star marrow component relation: %+v", relation)
		}
	}
}
