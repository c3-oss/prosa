package handlers

import (
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
)

type scannable interface {
	Scan(dest ...any) error
}

func scanSessionRow(r scannable) (*prosav1.Session, error) {
	var (
		s                                                             prosav1.Session
		projectPath, projectRemote, projectMarker, firstPrompt, model *string
		parentSessionID                                               *string
		usageSession                                                  *string
		totalTokens, inputTokens, outputTokens                        *int64
		cachedTokens, cacheReadTokens, cacheCreationTokens            *int64
		started, lastAct                                              time.Time
	)
	if err := r.Scan(
		&s.Id, &s.Agent, &s.DeviceId,
		&projectPath, &projectRemote, &projectMarker,
		&started, &lastAct,
		&firstPrompt, &model,
		&s.RawUri, &s.RawHash, &s.RawSize,
		&parentSessionID,
		&usageSession, &totalTokens, &inputTokens, &outputTokens,
		&cachedTokens, &cacheReadTokens, &cacheCreationTokens,
	); err != nil {
		return nil, err
	}
	if projectPath != nil {
		s.ProjectPath = *projectPath
	}
	if projectRemote != nil {
		s.ProjectRemote = *projectRemote
	}
	if projectMarker != nil {
		s.ProjectMarker = *projectMarker
	}
	if firstPrompt != nil {
		s.FirstPrompt = *firstPrompt
	}
	if model != nil {
		s.Model = *model
	}
	if parentSessionID != nil {
		s.ParentSessionId = *parentSessionID
	}
	s.StartedAt = timestamppb.New(started)
	s.LastActivityAt = timestamppb.New(lastAct)
	if usageSession != nil {
		s.Usage = &prosav1.TokenUsage{
			TotalTokens:         derefInt64(totalTokens),
			InputTokens:         derefInt64(inputTokens),
			OutputTokens:        derefInt64(outputTokens),
			CachedTokens:        derefInt64(cachedTokens),
			CacheReadTokens:     derefInt64(cacheReadTokens),
			CacheCreationTokens: derefInt64(cacheCreationTokens),
		}
	}
	return &s, nil
}

func scanSearchHit(r scannable) (*prosav1.SearchHit, error) {
	var (
		s                                                             prosav1.Session
		projectPath, projectRemote, projectMarker, firstPrompt, model *string
		parentSessionID                                               *string
		usageSession                                                  *string
		totalTokens, inputTokens, outputTokens                        *int64
		cachedTokens, cacheReadTokens, cacheCreationTokens            *int64
		started, lastAct, turnTS                                      time.Time
		role, kind, snippet                                           string
		toolName                                                      *string
		turnID                                                        int64
		rank                                                          float64
	)
	if err := r.Scan(
		&s.Id, &s.Agent, &s.DeviceId,
		&projectPath, &projectRemote, &projectMarker,
		&started, &lastAct,
		&firstPrompt, &model,
		&s.RawUri, &s.RawHash, &s.RawSize,
		&parentSessionID,
		&usageSession, &totalTokens, &inputTokens, &outputTokens,
		&cachedTokens, &cacheReadTokens, &cacheCreationTokens,
		&turnID, &turnTS, &role, &kind, &toolName,
		&snippet, &rank,
	); err != nil {
		return nil, err
	}
	if parentSessionID != nil {
		s.ParentSessionId = *parentSessionID
	}
	if projectPath != nil {
		s.ProjectPath = *projectPath
	}
	if projectRemote != nil {
		s.ProjectRemote = *projectRemote
	}
	if projectMarker != nil {
		s.ProjectMarker = *projectMarker
	}
	if firstPrompt != nil {
		s.FirstPrompt = *firstPrompt
	}
	if model != nil {
		s.Model = *model
	}
	s.StartedAt = timestamppb.New(started)
	s.LastActivityAt = timestamppb.New(lastAct)
	if usageSession != nil {
		s.Usage = &prosav1.TokenUsage{
			TotalTokens:         derefInt64(totalTokens),
			InputTokens:         derefInt64(inputTokens),
			OutputTokens:        derefInt64(outputTokens),
			CachedTokens:        derefInt64(cachedTokens),
			CacheReadTokens:     derefInt64(cacheReadTokens),
			CacheCreationTokens: derefInt64(cacheCreationTokens),
		}
	}
	hit := &prosav1.SearchHit{
		Session:    &s,
		Snippet:    snippet,
		Role:       role,
		TurnId:     turnID,
		TurnTs:     timestamppb.New(turnTS),
		Kind:       kind,
		MatchField: "turn.content",
		Rank:       rank,
	}
	if toolName != nil {
		hit.ToolName = *toolName
	}
	return hit, nil
}
