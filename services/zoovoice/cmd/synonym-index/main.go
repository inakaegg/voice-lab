// Command synonym-index は、Japanese WordNetのXMLから同義語indexを構築する。
package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/inakaegg/voice-lab/services/zoovoice/internal/synonymindex"
)

func main() {
	sourcePath := flag.String("source", "", "path to wnja-2.0.xml")
	outputPath := flag.String("output", "", "path to the SQLite index to write")
	flag.Parse()

	if *sourcePath == "" || *outputPath == "" {
		fmt.Fprintln(os.Stderr, "usage: synonym-index -source wnja-2.0.xml -output synonyms.sqlite")
		os.Exit(2)
	}

	sourceSHA, err := synonymindex.FileSHA256(*sourcePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "hash source: %v\n", err)
		os.Exit(1)
	}
	if err := synonymindex.Build(context.Background(), synonymindex.BuildOptions{
		SourcePath:   *sourcePath,
		SourceSHA256: sourceSHA,
		OutputPath:   *outputPath,
	}); err != nil {
		fmt.Fprintf(os.Stderr, "build synonym index: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("source_sha256=%s\noutput=%s\n", sourceSHA, *outputPath)
}
