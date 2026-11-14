// SPDX-License-Identifier: GPL-3.0
package statistic

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	C "github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/log"
)

const (
	trafficDays     = 7
	trafficKeys     = 256
	trafficKeyBytes = 253
	trafficFile     = "bettbox-traffic.json"
)

type trafficBytes struct {
	Upload   int64 `json:"upload"`
	Download int64 `json:"download"`
}

type trafficSample struct {
	profile string
	total   trafficBytes
}

type trafficDay struct {
	Devices       map[string]trafficBytes `json:"devices"`
	Domains       map[string]trafficBytes `json:"domains"`
	Subscriptions map[string]trafficBytes `json:"subscriptions"`
}

var trafficHistory struct {
	sync.Mutex
	profile atomic.Pointer[string]
	days    map[string]*trafficDay
	dirty   bool
}

func ConfigureTrafficHistory(profile string) {
	trafficHistory.Lock()
	defer trafficHistory.Unlock()
	trafficHistory.profile.Store(&profile)
	if profile == "" || trafficHistory.days != nil {
		return
	}
	trafficHistory.days = make(map[string]*trafficDay)
	path := filepath.Join(C.Path.HomeDir(), trafficFile)
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4<<20 {
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var saved map[string]*trafficDay
	if json.Unmarshal(data, &saved) != nil {
		return
	}
	now := time.Now()
	for date, day := range saved {
		if _, err := time.Parse(time.DateOnly, date); err != nil || day == nil || date < oldestTrafficDay(now) || date > now.Format(time.DateOnly) {
			trafficHistory.dirty = true
			continue
		}
		restored := newTrafficDay()
		restoreTraffic(restored.Devices, day.Devices)
		restoreTraffic(restored.Domains, day.Domains)
		restoreTraffic(restored.Subscriptions, day.Subscriptions)
		trafficHistory.days[date] = restored
	}
}

func newTrafficDay() *trafficDay {
	return &trafficDay{
		Devices: make(map[string]trafficBytes), Domains: make(map[string]trafficBytes),
		Subscriptions: make(map[string]trafficBytes),
	}
}

func oldestTrafficDay(now time.Time) string {
	return now.AddDate(0, 0, 1-trafficDays).Format(time.DateOnly)
}

func restoreTraffic(target, saved map[string]trafficBytes) {
	for key, amount := range saved {
		if amount.Upload >= 0 && amount.Download >= 0 {
			addTraffic(target, key, amount)
		}
	}
}

func addTraffic(counts map[string]trafficBytes, key string, amount trafficBytes) {
	if len(key) > trafficKeyBytes || key == "" {
		key = "(未知)"
	}
	if _, found := counts[key]; !found && len(counts) >= trafficKeys-1 {
		key = "(其他)"
	}
	current := counts[key]
	counts[key] = trafficBytes{current.Upload + amount.Upload, current.Download + amount.Download}
}

func recordTraffic(info *TrackerInfo, sample *trafficSample) {
	if info == nil || info.Metadata == nil || sample == nil {
		return
	}
	total := trafficBytes{info.UploadTotal.Load(), info.DownloadTotal.Load()}
	amount := trafficBytes{total.Upload - sample.total.Upload, total.Download - sample.total.Download}
	sample.total = total
	if amount.Upload <= 0 && amount.Download <= 0 {
		return
	}
	trafficHistory.Lock()
	defer trafficHistory.Unlock()
	if TrafficProfile() == "" {
		return
	}
	now := time.Now()
	date := now.Format(time.DateOnly)
	day := trafficHistory.days[date]
	if day == nil {
		pruneTrafficHistory(now)
		day = newTrafficDay()
		trafficHistory.days[date] = day
	}
	device := ""
	if info.Metadata.SrcIP.IsValid() {
		device = info.Metadata.SrcIP.Unmap().String()
	}
	domain := strings.TrimSuffix(strings.ToLower(info.Metadata.RuleHost()), ".")
	addTraffic(day.Devices, device, amount)
	addTraffic(day.Domains, domain, amount)
	addTraffic(day.Subscriptions, sample.profile, amount)
	trafficHistory.dirty = true
}

func TrafficProfile() string {
	if profile := trafficHistory.profile.Load(); profile != nil {
		return *profile
	}
	return ""
}

func FlushTrafficHistory() {
	DefaultManager.sampleTrafficHistory()
	trafficHistory.Lock()
	defer trafficHistory.Unlock()
	pruneTrafficHistory(time.Now())
	if !trafficHistory.dirty {
		return
	}
	if err := saveTrafficHistory(); err != nil {
		log.Warnln("Bettbox traffic history: %v", err)
		return
	}
	trafficHistory.dirty = false
}

func pruneTrafficHistory(now time.Time) {
	first, last := oldestTrafficDay(now), now.Format(time.DateOnly)
	for date := range trafficHistory.days {
		if date < first || date > last {
			delete(trafficHistory.days, date)
			trafficHistory.dirty = true
		}
	}
}

func (m *Manager) sampleTrafficHistory() {
	m.historyMu.Lock()
	defer m.historyMu.Unlock()
	for id, sample := range m.trafficProfiles {
		if conn := m.Get(id); conn != nil {
			recordTraffic(conn.Info(), sample)
		}
	}
}

func saveTrafficHistory() error {
	dir := C.Path.HomeDir()
	file, err := os.CreateTemp(dir, ".bettbox-traffic-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	err = json.NewEncoder(file).Encode(trafficHistory.days)
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), filepath.Join(dir, trafficFile))
}
