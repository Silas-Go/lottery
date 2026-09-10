package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// 旧标签页不能借浏览器中新写入的 Cookie 隐式操作新订单。
func TestOrderRequestIdentityDoesNotBorrowCookies(t *testing.T) {
	for _, form := range []string{"uid=7&gid=4", "uid=7&gid=4&order_id=old-order&run_id=old-run"} {
		request := httptest.NewRequest(http.MethodPost, "/giveup", strings.NewReader(form))
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		request.AddCookie(&http.Cookie{Name: "order_id", Value: "new-order"})
		request.AddCookie(&http.Cookie{Name: "run_id", Value: "new-run"})
		ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
		ctx.Request = request
		got := orderRequestIdentity(ctx)
		if strings.Contains(form, "old-order") {
			if got.OrderID != "old-order" || got.RunID != "old-run" {
				t.Fatalf("explicit identity replaced: %+v", got)
			}
		} else if got.OrderID != "" || got.RunID != "" {
			t.Fatalf("cookie borrowed: %+v", got)
		}
	}
}
