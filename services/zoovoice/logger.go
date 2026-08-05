package main

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"time"
)

var jst = time.FixedZone("JST", 9*60*60)

func openServiceLogger(path string) (*log.Logger, io.Closer) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err == nil {
		file, openErr := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if openErr == nil {
			return log.New(file, "", 0), file
		}
		fmt.Fprintf(os.Stderr, "zoovoice: log file unavailable: %v\n", openErr)
	} else {
		fmt.Fprintf(os.Stderr, "zoovoice: log directory unavailable: %v\n", err)
	}
	return log.New(os.Stderr, "", 0), io.NopCloser(nilReader{})
}

func logProgress(
	logger *log.Logger,
	started time.Time,
	stage string,
	status string,
	format string,
	args ...any,
) {
	detail := ""
	if format != "" {
		detail = " " + fmt.Sprintf(format, args...)
	}
	logger.Printf(
		"time=%s elapsed_ms=%d stage=%s status=%s%s",
		time.Now().In(jst).Format("2006-01-02T15:04:05.000-07:00"),
		time.Since(started).Milliseconds(),
		stage,
		status,
		detail,
	)
}

type nilReader struct{}

func (nilReader) Read([]byte) (int, error) {
	return 0, io.EOF
}
