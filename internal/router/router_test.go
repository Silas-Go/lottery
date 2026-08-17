package router

import (
	"silas/internal/handler"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestRemovedLegacyRoutesStayUnregistered(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	registerAPIRoutes(engine, Handlers{
		Archive:     &handler.ArchiveHandler{},
		PurchaseLab: &handler.PurchaseLabHandler{},
		Gift:        &handler.GiftHandler{},
		Order:       &handler.OrderHandler{},
		Lab:         &handler.LabHandler{},
		Loadtest:    &handler.LoadtestHandler{},
	})

	registered := make(map[string]struct{}, len(engine.Routes()))
	for _, route := range engine.Routes() {
		registered[route.Method+" "+route.Path] = struct{}{}
	}

	for _, removed := range []string{
		"GET /api/archives",
		"GET /gifts",
		"GET /lucky/cacheaside",
	} {
		if _, exists := registered[removed]; exists {
			t.Fatalf("removed route is registered again: %s", removed)
		}
	}

	for _, active := range []string{
		"GET /api/archives/:id/direct",
		"GET /api/seckill/materials",
		"GET /lucky",
	} {
		if _, exists := registered[active]; !exists {
			t.Fatalf("active replacement route is missing: %s", active)
		}
	}
}
