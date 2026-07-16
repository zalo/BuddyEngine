//go:build !windows

package workshop

// Steam Workshop integration is Windows-only (steam_api64.dll); elsewhere
// the provider is permanently inactive and only local packs load.
type steamProvider struct {
	active bool
}

func newSteamProvider() *steamProvider { return &steamProvider{} }

func (p *steamProvider) subscribedItemDirs() []string { return nil }
