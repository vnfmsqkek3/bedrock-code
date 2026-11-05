# Implementation Tasks

## Task 1: ChatPanelContext 생성

### Description
채팅 패널의 열림/닫힘 상태를 AppLayout과 ProjectDetailPage 간에 공유하기 위한 React Context를 생성한다.

### Files to Create
- `packages/frontend/src/contexts/ChatPanelContext.tsx`

### Requirements
- [x] `ChatPanelProvider` 컴포넌트 생성 — children을 감싸는 Provider
- [x] `useChatPanel()` 커스텀 훅 생성 — context value 반환
- [x] 상태: `isChatOpen` (boolean) — localStorage `idp-chat-panel-open` 키와 동기화
- [x] 메서드: `toggleChat()`, `openChat()`, `closeChat()`
- [x] 기본값: `false` (닫힘)
- [x] localStorage 접근 실패 시 기본값 사용, 에러 로깅

### Files to Modify
- `packages/frontend/src/App.tsx` 또는 루트 레이아웃 — `ChatPanelProvider`로 감싸기

---

## Task 2: AppLayout 사이드바에 AI Chat 버튼 추가

### Description
AppLayout 사이드바 네비게이션에 "AI Chat" 토글 버튼을 추가한다.

### Files to Modify
- `packages/frontend/src/components/AppLayout/index.tsx`

### Requirements
- [x] 기존 navItems(프로젝트, 아티팩트) 아래에 "AI Chat" 버튼 렌더링
- [x] `useChatPanel()` 훅으로 `isChatOpen`, `toggleChat` 사용
- [x] 현재 pathname이 `/projects/:projectId` 패턴일 때만 활성화 (enabled)
- [x] 다른 라우트에서는 disabled 스타일 (opacity-50, pointer-events-none)
- [x] `isChatOpen === true`일 때 active 스타일 적용 (기존 navItem active 스타일과 동일)
- [x] 사이드바 collapsed 상태에서도 아이콘만 표시
- [x] 아이콘: MessageSquare 또는 유사한 chat 아이콘 (lucide-react 또는 inline SVG)
- [x] i18n 키 추가: `nav.aiChat`

---

## Task 3: ProjectDetailPage 조건부 채팅 패널 렌더링

### Description
`$projectId.tsx`의 ResizablePanelGroup에서 `isChatOpen` 상태에 따라 ChatPanel을 조건부 렌더링한다.

### Files to Modify
- `packages/frontend/src/routes/projects/$projectId.tsx`

### Requirements
- [x] `useChatPanel()` 훅 import 및 `isChatOpen` 가져오기
- [x] `isChatOpen === true`: 기존 3-zone 구조 유지 (Chat + Side 패널)
- [x] `isChatOpen === false`: ChatPanel과 해당 ResizableHandle 제거, SidePanel이 전체 오른쪽 공간 차지
- [x] ResizablePanelGroup의 `key` prop을 `isChatOpen` 포함하여 레이아웃 재계산
- [x] 채팅 메시지 상태는 `useChatSession` 훅에서 유지되므로 별도 보존 로직 불필요
- [x] sidePanelCollapsed 상태와 조합 처리 (채팅 닫힘 + 사이드패널 닫힘 = 문서 트리만 표시)

---

## Task 4: SidebarSessionList에서 채팅 패널 자동 오픈

### Description
사이드바에서 채팅 세션 선택 또는 "New Chat" 클릭 시 채팅 패널이 닫혀 있으면 자동으로 연다.

### Files to Modify
- `packages/frontend/src/components/AppLayout/SidebarSessionList.tsx`

### Requirements
- [x] `useChatPanel()` 훅 import 및 `openChat` 사용
- [x] 세션 항목 클릭 핸들러에서 기존 `onSessionSelect` 호출 전/후에 `openChat()` 호출
- [x] "New Chat" 버튼 클릭 핸들러에서 `openChat()` 호출
- [x] 이미 열려 있을 때는 추가 동작 없음 (openChat 내부에서 처리)

---

## Task 5: 랜딩 페이지 DetailPanel 버튼 레이아웃 변경

### Description
ProjectExplorer의 DetailPanel에서 "문서 업로드"를 주요 액션으로, "워크스페이스 열기"를 보조 액션으로 변경한다.

### Files to Modify
- `packages/frontend/src/components/ProjectExplorer/index.tsx` (DetailPanel 컴포넌트)

### Requirements
- [x] DetailPanel props에 `onUpload: () => void` 추가
- [x] "문서 업로드" 버튼: primary 스타일 (기존 "워크스페이스 열기"와 동일한 accent 배경)
- [x] "워크스페이스 열기" 버튼: secondary/outline 스타일로 변경 (border + text color)
- [x] 버튼 순서: 왼쪽부터 [문서 업로드 (primary)] [워크스페이스 열기 (secondary)] [설정 (icon)]
- [x] CloudUpload 아이콘을 업로드 버튼에 추가
- [x] i18n 키: `documents.uploadDocuments` (기존 키 재사용)

---

## Task 6: DocumentUploadModal에 프로젝트 선택기 추가

### Description
DocumentUploadModal에 프로젝트 선택 드롭다운을 추가하여, 랜딩 페이지에서 열릴 때 대상 프로젝트를 선택할 수 있게 한다.

### Files to Modify
- `packages/frontend/src/components/DocumentUploadModal.tsx`

### Requirements
- [x] 새 props 추가: `showProjectSelector`, `projects`, `selectedProjectId`, `onProjectSelect`, `projectsLoading`, `projectsError`
- [x] `showProjectSelector === true`일 때: Drop Zone 상단에 프로젝트 선택 드롭다운 렌더링
- [x] 드롭다운: 프로젝트 이름 목록, 현재 선택 표시
- [x] `projectsLoading === true`일 때: 드롭다운에 로딩 스피너
- [x] `projectsError`가 있을 때: 에러 메시지 표시, 업로드 버튼 disabled
- [x] `showProjectSelector === false` (기본값)일 때: 드롭다운 숨김 (기존 동작 유지)
- [x] 스타일: 기존 모달의 dark mode 지원 패턴 준수

---

## Task 7: ProjectExplorer에 업로드 모달 통합

### Description
랜딩 페이지(ProjectExplorer)에서 DocumentUploadModal을 열고 선택된 프로젝트에 업로드하는 플로우를 구현한다.

### Files to Modify
- `packages/frontend/src/components/ProjectExplorer/index.tsx`

### Requirements
- [x] `showUploadModal` state 추가
- [x] `uploadingFromExplorer` state 추가
- [x] `DocumentUploadModal` 임포트 및 렌더링
- [x] `showProjectSelector={true}` 전달, `projects` 목록 전달
- [x] `selectedProjectId`는 현재 DetailPanel에서 선택된 프로젝트 ID
- [x] 프로젝트 변경 시 해당 프로젝트의 language, document_prompt를 모달에 전달
- [x] 업로드 완료 시 `docsByProject` state에 새 문서 반영 (API 재호출 또는 optimistic update)
- [x] DetailPanel의 `onUpload` prop에 `() => setShowUploadModal(true)` 연결
- [x] `useDocuments` 훅의 업로드 로직 재사용 또는 간소화된 버전 구현

---

## Task 8: i18n 키 추가

### Description
새로 추가된 UI 텍스트에 대한 번역 키를 추가한다.

### Files to Modify
- `packages/frontend/src/locales/ko.json` (또는 해당 i18n 리소스 파일)
- `packages/frontend/src/locales/en.json`

### Requirements
- [x] `nav.aiChat`: "AI Chat" / "AI 채팅"
- [x] `projects.uploadDocuments`: "문서 업로드" / "Upload Documents"
- [x] `documents.selectProject`: "프로젝트 선택" / "Select Project"
- [x] `documents.projectLoadError`: "프로젝트 목록을 불러올 수 없습니다" / "Failed to load projects"
- [x] 기존 키 재사용 가능한 항목은 새로 만들지 않음

---

## Task 9: 테스트 작성

### Description
주요 로직에 대한 단위 테스트를 작성한다.

### Files to Create
- `packages/frontend/src/contexts/__tests__/ChatPanelContext.test.tsx`
- `packages/frontend/src/components/__tests__/DocumentUploadModal.test.tsx` (프로젝트 선택기 관련)

### Requirements
- [x] ChatPanelContext: 초기값 false, toggle 동작, localStorage 연동, openChat/closeChat
- [x] DocumentUploadModal: showProjectSelector=true일 때 드롭다운 렌더링, false일 때 미렌더링
- [x] DocumentUploadModal: projectsError 시 업로드 버튼 disabled 확인
- [x] vitest + @testing-library/react 사용 (프로젝트 기존 설정 활용)

---

## Implementation Order

권장 구현 순서:
1. **Task 1** → Context 생성 (다른 태스크의 의존성)
2. **Task 8** → i18n 키 추가 (UI 작업에 필요)
3. **Task 2** → 사이드바 버튼 (Context 소비)
4. **Task 3** → 워크스페이스 레이아웃 변경 (Context 소비)
5. **Task 4** → 세션 리스트 연동
6. **Task 5** → DetailPanel 버튼 변경
7. **Task 6** → Upload Modal 프로젝트 선택기
8. **Task 7** → ProjectExplorer 업로드 통합
9. **Task 9** → 테스트
