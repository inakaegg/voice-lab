package main

import "strings"

// 鳴き声素材1ファイル分の出典表示。音源manifestを正とする。
type soundCredit struct {
	License   string `json:"license"`
	Creator   string `json:"creator,omitempty"`
	SourceURL string `json:"source_url,omitempty"`
}

// 1行のクレジット表記。空の項目は落とす。
func (credit soundCredit) Line() string {
	parts := []string{credit.License}
	if credit.Creator != "" {
		parts = append(parts, credit.Creator)
	}
	if credit.SourceURL != "" {
		parts = append(parts, credit.SourceURL)
	}
	return strings.Join(parts, " / ")
}
