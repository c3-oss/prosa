# DuckDB Query Recipes

Run these recipes after exporting Parquet:

```bash
prosa export parquet
```

You can also use `prosa analytics <report> --refresh` when a built-in report
covers the question.

## Session Inventory By Source

```bash
prosa query duckdb "
  select source_tool, count(*) as sessions
  from session_facts
  group by 1
  order by sessions desc
"
```

## Recent Sessions By Project

```bash
prosa query duckdb "
  select start_ts, source_tool, project_name, model_last, message_count, tool_call_count, title
  from session_facts
  order by start_ts desc nulls last
  limit 25
"
```

## Most Used Tools

```bash
prosa query duckdb "
  select tool_name, canonical_tool_type, count(*) as calls
  from tool_usage_facts
  group by 1, 2
  order by calls desc
  limit 25
"
```

## Tool Error Rates

```bash
prosa query duckdb "
  select tool_name,
         count(*) as calls,
         sum(case when is_error = 1 or call_status = 'error' then 1 else 0 end) as errors
  from tool_usage_facts
  group by 1
  order by errors desc, calls desc
"
```

## Failed Commands With Preview

```bash
prosa query duckdb "
  select timestamp, source_tool, project_name, tool_name, status, exit_code, preview
  from error_facts
  where error_category = 'tool_result'
  order by timestamp desc nulls last
  limit 50
"
```

## Long-Running Tool Results

```bash
prosa query duckdb "
  select timestamp_start, source_tool, project_name, tool_name, result_duration_ms, command
  from tool_usage_facts
  where result_duration_ms is not null
  order by result_duration_ms desc
  limit 25
"
```

## Model Usage By Project

```bash
prosa query duckdb "
  select model, source_tool, project_name, session_count, message_count, first_seen_ts, last_seen_ts
  from model_usage
  order by session_count desc, observation_count desc
"
```

## Low-Confidence Timelines

```bash
prosa query duckdb "
  select start_ts, source_tool, project_name, session_id, title
  from session_facts
  where timeline_confidence = 'low'
  order by start_ts desc nulls last
"
```

## Project Activity

```bash
prosa query duckdb "
  select latest_session_ts, source_tool, project_name, session_count, message_count,
         tool_call_count, tool_error_count
  from project_activity
  order by latest_session_ts desc nulls last
"
```

## Searchable Text By Field

```bash
prosa query duckdb "
  select field_kind, count(*) as docs
  from search_docs
  group by 1
  order by docs desc
"
```

## Commands Matching A Term

```bash
prosa query duckdb "
  select timestamp, session_id, tool_name, text
  from search_docs
  where field_kind = 'command'
    and text ilike '%pnpm%'
  order by timestamp desc nulls last
  limit 50
"
```

## Import And Normalization Issues

```bash
prosa query duckdb "
  select error_category, source_tool, status, count(*) as n
  from error_facts
  group by 1, 2, 3
  order by n desc
"
```

