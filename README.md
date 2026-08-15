# livermore

Hermes Agent(NousResearch/hermes-agent)의 두 기능을 Claude Code 플러그인으로 이식한 것.
모든 훅은 Node.js — **PowerShell은 어디에도 쓰지 않는다** (Windows에서는 exec form으로 `node.exe`를 직접 spawn, 백그라운드 리뷰 기동만 cmd.exe 경유).

## 동작 요약

### 1. 메모리 캡 (`hooks/memory-cap.js`, PreToolUse: `Write|Edit`)

`/memory/` 경로에 **새 파일을 추가하는 Write**를 가로채서, 그 디렉터리의 `MEMORY.md` 인덱스가
한도(기본 **20줄 또는 4KB**)를 넘어 있으면 exit 2로 차단하고 Hermes식 에러를 돌려준다 —
현재 수치, 인덱스 전체 내용, "통합/삭제 후 같은 턴에서 재시도" 지시문 포함.

- 기존 파일 수정(Edit 전부, 기존 파일 Write, `MEMORY.md` 재작성)은 항상 통과 — 정리를 막으면 데드락.
- 무한루프 방지: 같은 세션에서 **3회 차단되면** 이후는 경고만 내고 통과 (`.state.json`에 세션별 기록).

### 2. 자기개선 리뷰 (`hooks/self-review.js`, Stop)

턴 수를 `.state.json`에 **전역 누적**으로 기록하고, **10턴마다 1회**(`review_interval`)
transcript 마지막 **24개 메시지**(digest, 메시지당 1,000자 절단)를 뽑아
`claude -p --model claude-haiku-4-5-20251001`을 **백그라운드(detached)**로 기동한다.
훅 자체는 즉시 exit 0 — 메인 세션을 블록하지 않는다.

리뷰 세션 가드:

| 가드 | 구현 |
|---|---|
| 쓰기 격리 | `~/.claude/skills/auto-<이름>/` 아래에만 생성 (Claude Code는 `skills/` 하위 중첩 디렉터리를 스킬로 로드하지 않으므로 `auto/` 폴더 대신 `auto-` 접두사 사용). 사람이 만든 스킬은 절대 금지 |
| read-before-write | 기존 auto 스킬 patch 전 SKILL.md 읽기 강제 (프롬프트) |
| 삭제 금지 | delete 대신 `~/.claude/skills-archive/`로 이동만 허용 |
| 이름 충돌 | 동명 존재 시 생성 금지, patch로 전환 |
| frontmatter | `name`: `auto-` 접두사 kebab-case ≤64자, `description` ≤500자 (트리거 품질 위해 60→500 상향) |
| 재귀 방지 | 리뷰 세션은 `LIVERMORE_REVIEW=1`을 상속받아 자기 Stop 훅에서 즉시 종료 (카운트도 안 함) |
| 권한 | `--allowedTools Read,Glob,Grep,Write,Edit`만 허용 (headless라 승인 프롬프트에 답할 수 없음) |
| 저장 금지 목록 | 환경 의존 실패 / 툴 부정 단정 / 일시 에러 / 일회성 서사 / 미해결 실패의 워크플로화 — 프롬프트에 명시 |

## 끄는 법

`config.json`에서:

```json
{ "memory_cap_enabled": false, "review_enabled": false }
```

기능별로 따로 끌 수 있다. 플러그인 전체를 끄려면 Claude Code에서 `/plugin` → livermore 비활성화.

## 튜닝값 (`config.json`)

| 키 | 기본값 | 의미 |
|---|---|---|
| `memory_index_max_lines` | 20 | MEMORY.md 인덱스 줄 수 한도 (빈 줄 제외) |
| `memory_index_max_bytes` | 4096 | 인덱스 크기 한도 |
| `review_interval` | 10 | 몇 턴마다 리뷰할지 (전역 누적, 리뷰 1회 ≈ 30K 토큰) |
| `review_model` | `claude-haiku-4-5-20251001` | 리뷰 세션 모델 |
| `claude_command` | `claude` | PATH에 없으면 전체 경로로 교체 |
| `digest_message_count` | 24 | digest에 넣을 메시지 수 |
| `digest_message_max_chars` | 1000 | 메시지당 절단 길이 |

## 테스트

```
node test.js
```

프레임워크 없이 `assert` 기반 15개. dry-run은 `LIVERMORE_DRYRUN=1`
(실제 `claude -p` 기동 대신 명령을 stdout에 출력).
