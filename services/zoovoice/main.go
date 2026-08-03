package main

import (
	"context"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

const defaultComposeTimeout = 85 * time.Second

func main() {
	logger, closer := openServiceLogger(defaultLogPath())
	defer closer.Close()

	assetsRoot := defaultAssetsRoot()
	catalog, err := loadCatalog(
		filepath.Join(assetsRoot, "animals.json"),
		filepath.Join(assetsRoot, "cc0"),
		os.Getenv("ZOOVOICE_EXTRA_ASSETS_DIR"),
		logger,
	)
	if err != nil {
		logger.Fatalf("zoovoice startup failed: %v", err)
	}
	runtimeDependencies, err := loadRuntimeDependencies(
		execCommandRunner{},
		filepath.Join(assetsRoot, "association-aliases.json"),
	)
	if err != nil {
		logger.Fatalf("zoovoice startup failed: %v", err)
	}
	defer runtimeDependencies.Close()
	timeout := durationFromEnv("ZOOVOICE_TIMEOUT_SECONDS", defaultComposeTimeout)
	activeComposer := newComposer(
		catalog,
		execCommandRunner{},
		runtimeDependencies.transcriber,
		runtimeDependencies.associator,
		rand.New(rand.NewSource(time.Now().UnixNano())),
		timeout,
		logger,
	)
	port := serverPort()
	server := &http.Server{
		Addr:              fmt.Sprintf(":%d", port),
		Handler:           newHTTPHandler(catalog, activeComposer, logger),
		ReadHeaderTimeout: 5 * time.Second,
	}

	stopContext, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	serverError := make(chan error, 1)
	go func() {
		logger.Printf(
			"time=%s elapsed_ms=0 stage=server status=start port=%d animals=%d timeout_seconds=%.0f",
			time.Now().In(jst).Format("2006-01-02T15:04:05.000-07:00"),
			port,
			len(catalog.Animals),
			timeout.Seconds(),
		)
		serverError <- server.ListenAndServe()
	}()

	select {
	case err := <-serverError:
		if err != nil && err != http.ErrServerClosed {
			logger.Fatalf("zoovoice server failed: %v", err)
		}
	case <-stopContext.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			logger.Printf("zoovoice shutdown failed: %v", err)
		}
	}
}

func serverPort() int {
	if os.Getenv("ZOOVOICE_PORT") != "" {
		return integerFromEnv("ZOOVOICE_PORT", 8090)
	}
	return integerFromEnv("PORT", 8090)
}

func defaultAssetsRoot() string {
	if configured := os.Getenv("ZOOVOICE_ASSETS_DIR"); configured != "" {
		return configured
	}
	for _, candidate := range []string{
		filepath.Join("services", "zoovoice", "assets"),
		"assets",
	} {
		if regularFileExists(filepath.Join(candidate, "animals.json")) {
			return candidate
		}
	}
	return filepath.Join("services", "zoovoice", "assets")
}

func defaultLogPath() string {
	if configured := os.Getenv("ZOOVOICE_LOG_PATH"); configured != "" {
		return configured
	}
	if directoryExists(filepath.Join("services", "zoovoice")) {
		return filepath.Join("logs", "zoovoice.log")
	}
	return filepath.Join("..", "..", "logs", "zoovoice.log")
}

func integerFromEnv(name string, fallback int) int {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 || parsed > 65535 {
		log.Fatalf("%s must be an integer from 1 to 65535", name)
	}
	return parsed
}

func durationFromEnv(name string, fallback time.Duration) time.Duration {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	seconds, err := strconv.Atoi(value)
	if err != nil || seconds < 1 {
		log.Fatalf("%s must be a positive integer", name)
	}
	return time.Duration(seconds) * time.Second
}
