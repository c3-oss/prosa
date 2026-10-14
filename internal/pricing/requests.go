package pricing

import (
	"strings"
	"time"

	"github.com/c3-oss/prosa/pkg/session"
)

type UsageCost struct {
	Model string
	Usage session.TokenUsage
	Cost  session.CostSummary
}

func SessionCost(s session.Session) session.CostSummary {
	parts := UsageCosts(s)
	costs := make([]session.CostSummary, len(parts))
	for i := range parts {
		costs[i] = parts[i].Cost
	}
	return CombineCosts(costs...)
}

// UsageCosts chooses one complete usage basis, so calls and aggregates never overlap.
func UsageCosts(s session.Session) []UsageCost {
	if s.RequestCoverage == session.RequestCoverageComplete && len(s.Requests) > 0 {
		var sum session.TokenUsage
		for _, req := range s.Requests {
			sum.Add(req.Usage)
		}
		if s.Usage == nil || sum == *s.Usage {
			out := make([]UsageCost, 0, len(s.Requests))
			for _, req := range s.Requests {
				if !session.HasTokenUsage(&req.Usage) {
					continue
				}
				model := req.Model
				if model == "" && s.Model != nil {
					model = *s.Model
				}
				out = append(out, UsageCost{Model: model, Usage: req.Usage, Cost: RequestCost(req, model, s.StartedAt)})
			}
			return out
		}
	}
	if s.Usage == nil {
		if len(s.Requests) > 0 {
			out := make([]UsageCost, 0, len(s.Requests))
			for _, req := range s.Requests {
				if !session.HasTokenUsage(&req.Usage) {
					continue
				}
				model := req.Model
				if model == "" && s.Model != nil {
					model = *s.Model
				}
				cost := RequestCost(req, model, s.StartedAt)
				if cost.USD != nil {
					cost.Status = session.CostPartial
				}
				out = append(out, UsageCost{Model: model, Usage: req.Usage, Cost: cost})
			}
			return out
		}
		return nil
	}
	model := ""
	if s.Model != nil {
		model = *s.Model
	}
	cost := RequestCost(session.RequestUsage{Usage: *s.Usage}, model, s.StartedAt)
	if cost.USD != nil {
		cost.Status = session.CostEstimated
	}
	return []UsageCost{{Model: model, Usage: *s.Usage, Cost: cost}}
}

func CombineCosts(costs ...session.CostSummary) session.CostSummary {
	out := session.CostSummary{Status: session.CostUnavailable}
	var total float64
	var priced, estimated, partial bool
	for _, c := range costs {
		out.PricedTokens += c.PricedTokens
		out.UnpricedTokens += c.UnpricedTokens
		if c.USD != nil {
			priced = true
			total += *c.USD
		}
		estimated = estimated || c.Status == session.CostEstimated
		partial = partial || c.Status == session.CostPartial || c.Status == session.CostUnavailable || c.UnpricedTokens > 0
	}
	if !priced {
		return out
	}
	out.USD = &total
	switch {
	case partial:
		out.Status = session.CostPartial
	case estimated:
		out.Status = session.CostEstimated
	default:
		out.Status = session.CostCalculated
	}
	return out
}

func RequestCost(req session.RequestUsage, fallbackModel string, fallbackTime time.Time) session.CostSummary {
	u := req.Usage
	tokens := u.TotalTokens
	if tokens == 0 {
		tokens = u.InputTokens + u.OutputTokens
	}
	out := session.CostSummary{Status: session.CostUnavailable, UnpricedTokens: max(tokens, 0)}
	if !session.HasTokenUsage(&u) {
		return out
	}
	if u.TotalTokens > 0 && u.InputTokens == 0 && u.OutputTokens == 0 {
		return out
	}
	if u.InputTokens < 0 || u.OutputTokens < 0 || u.TotalTokens < 0 || u.CachedTokens < 0 || u.CacheReadTokens < 0 || u.CacheCreationTokens < 0 {
		return out
	}
	read := u.CacheReadTokens
	if read == 0 {
		read = u.CachedTokens
	}
	if read > u.InputTokens || u.CacheCreationTokens > u.InputTokens-read {
		return out
	}
	model := req.Model
	estimated := model == "" || req.Timestamp == nil
	if model == "" {
		model = fallbackModel
	}
	at := fallbackTime
	if req.Timestamp != nil {
		at = *req.Timestamp
	}
	if at.IsZero() {
		at = time.Now().UTC()
		estimated = true
	}
	key, fallback := modelKey(model)
	r, ok := Lookup(key, at)
	if !ok {
		return out
	}
	if key == "gpt-daybreak-blue" {
		key = "gpt-5.6-sol"
	}
	estimated = estimated || fallback
	if req.Provider != nil && !directProvider(key, *req.Provider) {
		estimated = true
	}
	if key == "gemini-3.6-flash" && at.Before(time.Date(2026, 8, 13, 0, 0, 0, 0, time.UTC)) {
		estimated = true
	}
	long, contextKnown := requestContext(key, req.PromptTokens)
	if !contextKnown {
		estimated = true
	}
	if long {
		switch {
		case key == "claude-haiku-5-5":
			r = scaleRates(r, 5, 5, 5)
		case strings.HasPrefix(key, "grok-"):
			r = scaleRates(r, 2, 2, 2)
		default:
			r = scaleRates(r, 2, 1.5, 2)
		}
	}
	var modeKnown bool
	r, modeKnown = processingRates(key, r, req.ServiceTier, req.Speed, long)
	estimated = estimated || !modeKnown
	if regionalModel(key) {
		if req.InferenceGeo == nil {
			estimated = true
		} else {
			switch strings.ToLower(*req.InferenceGeo) {
			case "global", "not_available":
			case "us", "eu", "regional":
				r = scaleRates(r, 1.1, 1.1, 1.1)
			default:
				estimated = true
			}
		}
	} else if req.InferenceGeo != nil && *req.InferenceGeo != "global" && *req.InferenceGeo != "not_available" {
		estimated = true
	}
	creationCost := float64(u.CacheCreationTokens) * r.CacheCreation
	if u.CacheCreationTokens > 0 {
		if strings.HasPrefix(key, "claude-") {
			if req.CacheCreation5mTokens != nil && req.CacheCreation1hTokens != nil &&
				*req.CacheCreation5mTokens >= 0 && *req.CacheCreation1hTokens >= 0 &&
				*req.CacheCreation5mTokens+*req.CacheCreation1hTokens == u.CacheCreationTokens {
				creationCost = float64(*req.CacheCreation5mTokens)*r.CacheCreation + float64(*req.CacheCreation1hTokens)*r.Input*2
			} else {
				estimated = true
			}
		} else if r.CacheCreation == 0 {
			creationCost = float64(u.CacheCreationTokens) * r.Input
			estimated = true
		}
	}
	cost := float64(u.InputTokens-read-u.CacheCreationTokens)*r.Input + float64(read)*r.CacheRead + creationCost + float64(u.OutputTokens)*r.Output
	out.USD, out.PricedTokens, out.UnpricedTokens = &cost, tokens, 0
	out.Status = session.CostCalculated
	if estimated {
		out.Status = session.CostEstimated
	}
	return out
}

func modelKey(model string) (string, bool) {
	norm := NormalizeModel(model)
	if canon, ok := modelAliases[norm]; ok {
		norm = canon
	}
	if _, ok := ratesByModel[norm]; ok {
		return norm, false
	}
	for _, key := range sortedPrefixKeys() {
		if strings.HasPrefix(norm, key+"-") {
			return key, true
		}
	}
	return norm, false
}

func requestContext(key string, prompt *int64) (bool, bool) {
	var threshold int64
	inclusive := false
	switch {
	case key == "claude-haiku-5-5":
		threshold = 100000
	case key == "gpt-5.4" || key == "gpt-5.4-pro" || key == "gpt-5.5" || key == "gpt-5.5-pro" ||
		key == "gpt-5.6-sol" || key == "gpt-daybreak-blue" || key == "gpt-5.6-terra" || key == "gpt-5.6-luna" || strings.HasPrefix(key, "gpt-6"):
		threshold = 272000
	case strings.HasPrefix(key, "grok-4.") || key == "grok-build-0.1":
		threshold, inclusive = 200000, true
	case key == "gemini-2.5-pro" || key == "gemini-3-pro" || key == "gemini-3-pro-preview" || key == "gemini-3.1-pro":
		threshold = 200000
	default:
		return false, true
	}
	if prompt == nil || *prompt < 0 {
		return false, false
	}
	return *prompt > threshold || inclusive && *prompt == threshold, true
}

func scaleRates(r Rates, input, output, cache float64) Rates {
	return Rates{Input: r.Input * input, Output: r.Output * output, CacheRead: r.CacheRead * cache, CacheCreation: r.CacheCreation * cache}
}

func processingRates(key string, r Rates, tier, speed *string, long bool) (Rates, bool) {
	mode := "standard"
	known := tier != nil
	if tier != nil {
		mode = strings.ToLower(*tier)
	}
	if speed != nil {
		switch strings.ToLower(*speed) {
		case "standard", "normal":
		case "fast", "ultrafast":
			if mode == "batch" || mode == "flex" {
				return r, false
			}
			if mode == "standard" || mode == "default" || mode == "auto" {
				mode = strings.ToLower(*speed)
			}
		default:
			known = false
		}
	}
	switch {
	case strings.HasPrefix(key, "gpt-") || key == "o3":
		switch mode {
		case "standard", "default":
			return r, known
		case "batch", "flex":
			if strings.Contains(key, "cyber") || strings.Contains(key, "rosalind") || strings.Contains(key, "codex") {
				return r, false
			}
			if mode == "batch" || strings.HasPrefix(key, "gpt-6") || strings.HasPrefix(key, "gpt-5.6") || key == "gpt-5.5" || key == "gpt-5.4" || key == "gpt-5.4-mini" || key == "gpt-5.4-nano" || key == "o3" {
				return scaleRates(r, .5, .5, .5), known
			}
		case "fast", "priority":
			factor := 2.0
			if key == "gpt-5.5" {
				factor = 2.5
			} else if key == "gpt-5-mini" {
				factor = 1.8
			} else if key == "o3" {
				factor = 1.75
			} else if key == "gpt-5.4-nano" || strings.HasSuffix(key, "-pro") || strings.Contains(key, "rosalind") || strings.Contains(key, "cyber") {
				return r, false
			}
			return scaleRates(r, factor, factor, factor), known && (!long || strings.HasPrefix(key, "gpt-6") || strings.HasPrefix(key, "gpt-5.6"))
		case "ultrafast":
			if key == "gpt-6-astra" || key == "gpt-6.1-sol" {
				return scaleRates(r, 6, 6, 6), known
			}
		}
	case strings.HasPrefix(key, "claude-"):
		fastSupported := key == "claude-opus-5-5" || key == "claude-opus-5" || key == "claude-opus-4-8"
		if mode == "priority" && fastSupported && speed != nil && strings.EqualFold(*speed, "fast") {
			return scaleRates(r, 2, 2, 2), false
		}
		if fastSupported && speed == nil && mode != "batch" {
			known = false
		}
		switch mode {
		case "standard", "default":
			return r, known
		case "batch":
			return scaleRates(r, .5, .5, .5), known
		case "fast":
			if fastSupported {
				return scaleRates(r, 2, 2, 2), known
			}
		}
	case strings.HasPrefix(key, "gemini-"):
		switch mode {
		case "standard", "default":
			return r, known
		case "batch", "flex":
			cache := .5
			if strings.HasPrefix(key, "gemini-2.5-") || strings.Contains(key, "pro") {
				cache = 1
			}
			out := scaleRates(r, .5, .5, cache)
			if key == "gemini-3.5-flash-lite" {
				out.CacheRead = .02e-6
			}
			return out, known
		case "priority", "fast":
			out := scaleRates(r, 1.8, 1.8, 1.8)
			if key == "gemini-3.5-flash-lite" {
				out.CacheRead = .05e-6
			}
			return out, known
		}
	case strings.HasPrefix(key, "grok-"):
		switch mode {
		case "standard", "default":
			return r, known && speed != nil
		case "batch":
			if key == "grok-4.3" || strings.HasPrefix(key, "grok-4.20") {
				return scaleRates(r, .8, .8, .8), known
			}
			return r, known
		case "priority":
			return scaleRates(r, 2, 2, 2), known
		case "fast":
			if key == "grok-4.7" {
				factor := 2.0
				if long {
					factor = 1.5
				}
				return scaleRates(r, factor, factor, factor), known
			}
		}
	case strings.HasPrefix(key, "composer-"):
		if mode == "standard" || mode == "default" {
			return r, strings.HasSuffix(key, "-fast") || known && speed != nil
		}
		if mode == "fast" && key == "composer-2.5" {
			fast, _ := Lookup("composer-2.5-fast", time.Time{})
			return fast, true
		}
		if mode == "fast" && strings.HasSuffix(key, "-fast") {
			return r, true
		}
	case strings.HasPrefix(key, "glm-"):
		return r, known && (mode == "standard" || mode == "default")
	}
	return r, false
}

func regionalModel(key string) bool {
	return strings.HasPrefix(key, "gpt-6") || strings.HasPrefix(key, "gpt-5.6") || strings.HasPrefix(key, "gpt-5.5") || strings.HasPrefix(key, "gpt-5.4") ||
		strings.Contains(key, "rosalind") || strings.HasPrefix(key, "grok-") || strings.HasPrefix(key, "claude-") &&
		(key == "claude-opus-4-6" || key == "claude-opus-4-7" || key == "claude-opus-4-8" || key == "claude-sonnet-4-6" || strings.Contains(key, "-5"))
}

func directProvider(key, provider string) bool {
	provider = strings.ToLower(provider)
	switch {
	case strings.HasPrefix(key, "claude-"):
		return provider == "anthropic"
	case strings.HasPrefix(key, "gpt-") || key == "o3":
		return provider == "openai"
	case strings.HasPrefix(key, "gemini-"):
		return provider == "google" || provider == "gemini"
	case strings.HasPrefix(key, "grok-"):
		return provider == "xai" || provider == "x.ai"
	case strings.HasPrefix(key, "glm-"):
		return provider == "zai" || provider == "z.ai"
	case strings.HasPrefix(key, "composer-"):
		return provider == "cursor"
	}
	return false
}
