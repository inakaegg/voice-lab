package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/inakaegg/voice-lab/services/zoovoice/internal/conceptindex"
)

func main() {
	var options conceptindex.BuildOptions
	flag.StringVar(&options.SourcePath, "source", "", "ConceptNet assertions CSV gzip path")
	flag.StringVar(&options.OutputPath, "output", "", "output SQLite path")
	flag.StringVar(&options.AliasesPath, "aliases", "", "association aliases JSON path")
	flag.StringVar(&options.SourceVersion, "source-version", "5.7.0", "ConceptNet source version")
	flag.StringVar(&options.SourceURL, "source-url", "https://s3.amazonaws.com/conceptnet/downloads/2019/edges/conceptnet-assertions-5.7.0.csv.gz", "ConceptNet source URL")
	flag.StringVar(&options.SourceSHA256, "source-sha256", "", "ConceptNet source SHA-256")
	flag.Int64Var(&options.CheckpointEvery, "checkpoint-every", 100_000, "source lines per checkpoint")
	flag.Parse()

	if err := conceptindex.Build(context.Background(), options, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "conceptnet index build failed: %v\n", err)
		os.Exit(1)
	}
}
