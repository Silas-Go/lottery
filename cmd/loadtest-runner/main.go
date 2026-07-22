package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"silas/internal/loadtest"
	"syscall"
	"time"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		client := &http.Client{Timeout: 2 * time.Second}
		response, err := client.Get("http://127.0.0.1" + envOr("LOADTEST_RUNNER_ADDR", ":8090") + "/health")
		if err != nil || response.StatusCode != http.StatusOK {
			os.Exit(1)
		}
		_ = response.Body.Close()
		return
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, nil)))
	runner, err := loadtest.NewRunner(loadtest.RunnerOptions{
		AppBaseURL: os.Getenv("LOADTEST_APP_BASE_URL"),
		StatePath:  os.Getenv("LOADTEST_STATE_PATH"),
		Wrk2Path:   os.Getenv("LOADTEST_WRK2_PATH"),
		ScriptPath: os.Getenv("LOADTEST_SCRIPT_PATH"),
	})
	if err != nil {
		slog.Error("loadtest runner initialization failed", "error", err)
		os.Exit(1)
	}

	server := &http.Server{
		Addr:              envOr("LOADTEST_RUNNER_ADDR", ":8090"),
		Handler:           runner.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	errChannel := make(chan error, 1)
	go func() {
		slog.Info("loadtest runner listening", "addr", server.Addr)
		errChannel <- server.ListenAndServe()
	}()

	stopChannel := make(chan os.Signal, 1)
	signal.Notify(stopChannel, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-errChannel:
		if err != nil && err != http.ErrServerClosed {
			slog.Error("loadtest runner stopped with error", "error", err)
			os.Exit(1)
		}
	case signalValue := <-stopChannel:
		slog.Info("loadtest runner shutting down", "signal", signalValue.String())
		shutdownContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			slog.Error("loadtest runner shutdown failed", "error", err)
		}
	}
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
