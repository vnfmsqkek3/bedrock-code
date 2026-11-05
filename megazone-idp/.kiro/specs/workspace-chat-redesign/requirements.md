# Requirements Document

## Introduction

워크스페이스 및 랜딩 페이지 UI 리디자인 기능. 현재 프로젝트 상세 페이지에서 채팅 패널이 전체 중앙 영역을 차지하는 구조를 개선하여, 좌측 사이드바에 "AI Chat" 버튼을 추가하고, 채팅을 토글 가능한 패널로 전환한다. 또한 랜딩 페이지의 프로젝트 상세 패널에서 "워크스페이스 열기" 버튼 대신 문서 업로드를 주요 액션으로 제공하며, 업로드 시 프로젝트/폴더 선택 기능을 지원한다.

## Glossary

- **Workspace_Page**: 프로젝트 상세 페이지 (`/projects/$projectId`), 문서 트리·채팅·인사이트를 통합 표시하는 3-존 레이아웃
- **Landing_Page**: 루트 경로 (`/`) 에서 프로젝트 탐색기(ProjectExplorer)를 렌더링하는 페이지
- **Sidebar**: AppLayout 컴포넌트의 좌측 내비게이션 바 (프로젝트, 아티팩트 등 네비게이션 링크 포함)
- **Chat_Panel**: 채팅 메시지 목록, 입력 박스, 스트리밍 블록을 포함하는 AI 대화 UI 컴포넌트
- **Detail_Panel**: Landing_Page의 ProjectExplorer 우측에 위치한 프로젝트 상세 정보 패널
- **Upload_Modal**: 문서 업로드 모달 (DocumentUploadModal 컴포넌트)
- **Project_Selector**: Upload_Modal 내부에서 업로드 대상 프로젝트를 선택하는 드롭다운 컴포넌트

## Requirements

### Requirement 1: AI Chat 사이드바 버튼 추가

**User Story:** As a 사용자, I want Sidebar에 AI Chat 버튼이 표시되기를, so that 워크스페이스 내에서 채팅 패널을 쉽게 열고 닫을 수 있다.

#### Acceptance Criteria

1. WHILE Workspace_Page가 활성 상태인 동안, THE Sidebar SHALL "AI Chat" 네비게이션 아이템을 프로젝트·아티팩트 항목 아래에 표시한다
2. WHEN 사용자가 AI Chat 버튼을 클릭할 때, THE Workspace_Page SHALL Chat_Panel을 토글(열기/닫기)한다
3. WHILE Chat_Panel이 열린 상태인 동안, THE Sidebar의 AI Chat 버튼 SHALL 활성(active) 스타일을 적용한다
4. WHILE Workspace_Page가 비활성(다른 라우트 활성) 상태인 동안, THE Sidebar SHALL AI Chat 버튼을 비활성(disabled) 상태로 표시한다

### Requirement 2: 워크스페이스 채팅 패널 레이아웃 변경

**User Story:** As a 사용자, I want 워크스페이스에서 채팅이 전체 중앙 영역을 차지하지 않고 토글 가능한 형태로 표시되기를, so that 문서 트리와 인사이트를 동시에 효율적으로 볼 수 있다.

#### Acceptance Criteria

1. WHEN Chat_Panel이 닫힌 상태에서 사용자가 AI Chat 버튼을 클릭할 때, THE Workspace_Page SHALL Chat_Panel을 ResizablePanelGroup의 중앙 영역에 슬라이드-인 애니메이션과 함께 표시한다
2. WHEN Chat_Panel이 열린 상태에서 사용자가 AI Chat 버튼을 다시 클릭할 때, THE Workspace_Page SHALL Chat_Panel을 숨기고 문서 트리와 인사이트 패널이 전체 가용 공간을 차지하도록 한다
3. WHILE Chat_Panel이 열린 상태인 동안, THE Workspace_Page SHALL 문서 트리(좌측), Chat_Panel(중앙), SidePanel(우측)의 3-존 레이아웃을 유지한다
4. WHILE Chat_Panel이 닫힌 상태인 동안, THE Workspace_Page SHALL 문서 트리(좌측)와 SidePanel(우측)의 2-존 레이아웃을 표시한다
5. THE Chat_Panel SHALL 이전 채팅 세션과 메시지 이력을 유지하여, 패널을 닫았다 다시 열어도 대화 내용이 보존된다

### Requirement 3: 랜딩 페이지 업로드 기능 제공

**User Story:** As a 사용자, I want 랜딩 페이지의 프로젝트 상세 패널에서 바로 문서를 업로드할 수 있기를, so that 워크스페이스를 열지 않고도 빠르게 문서를 등록할 수 있다.

#### Acceptance Criteria

1. THE Detail_Panel SHALL "워크스페이스 열기" 버튼 대신 "문서 업로드" 버튼을 주요 액션으로 표시한다
2. WHEN 사용자가 Detail_Panel의 "문서 업로드" 버튼을 클릭할 때, THE Landing_Page SHALL Upload_Modal을 표시한다
3. WHEN Upload_Modal이 Landing_Page에서 열릴 때, THE Upload_Modal SHALL 현재 선택된 프로젝트를 업로드 대상으로 자동 설정한다
4. WHEN 업로드가 성공적으로 완료될 때, THE Detail_Panel SHALL 문서 수 통계를 즉시 갱신한다
5. THE Detail_Panel SHALL "워크스페이스 열기" 기능을 보조 버튼(아이콘 버튼 또는 세컨더리 스타일)으로 유지한다

### Requirement 4: 업로드 모달 프로젝트 선택 기능

**User Story:** As a 사용자, I want 문서 업로드 시 대상 프로젝트를 선택할 수 있기를, so that 여러 프로젝트 중 원하는 곳에 문서를 업로드할 수 있다.

#### Acceptance Criteria

1. WHEN Upload_Modal이 Landing_Page에서 열릴 때, THE Upload_Modal SHALL Project_Selector를 파일 선택 영역 상단에 표시한다
2. THE Project_Selector SHALL 전체 프로젝트 목록을 드롭다운 형태로 표시한다
3. WHEN 사용자가 Project_Selector에서 다른 프로젝트를 선택할 때, THE Upload_Modal SHALL 업로드 대상 프로젝트를 선택된 프로젝트로 변경한다
4. WHEN Upload_Modal이 Workspace_Page에서 열릴 때, THE Upload_Modal SHALL Project_Selector를 숨기고 현재 워크스페이스의 프로젝트에 자동으로 업로드한다
5. IF 프로젝트 목록 로딩에 실패할 때, THEN THE Project_Selector SHALL 오류 메시지를 표시하고 업로드 버튼을 비활성화한다

### Requirement 5: 채팅 상태 동기화

**User Story:** As a 사용자, I want 사이드바 채팅 버튼과 워크스페이스 채팅 상태가 동기화되기를, so that 일관된 사용 경험을 얻을 수 있다.

#### Acceptance Criteria

1. WHEN 사용자가 사이드바의 채팅 세션 목록에서 세션을 선택할 때, THE Chat_Panel SHALL 해당 세션의 메시지를 로드하고, Chat_Panel이 닫혀 있으면 자동으로 열린다
2. WHEN 사용자가 사이드바의 "New Chat" 버튼을 클릭할 때, THE Chat_Panel SHALL 새 세션을 시작하고, Chat_Panel이 닫혀 있으면 자동으로 열린다
3. WHILE Chat_Panel이 닫힌 상태인 동안, THE Sidebar의 채팅 세션 목록 SHALL 계속 표시되어 접근 가능한 상태를 유지한다

### Requirement 6: 레이아웃 상태 유지

**User Story:** As a 사용자, I want 채팅 패널 열림/닫힘 상태가 세션 간에 유지되기를, so that 매번 패널을 다시 열 필요가 없다.

#### Acceptance Criteria

1. WHEN 사용자가 Chat_Panel을 열거나 닫을 때, THE Workspace_Page SHALL 해당 상태를 localStorage에 저장한다
2. WHEN 사용자가 Workspace_Page를 다시 방문할 때, THE Workspace_Page SHALL localStorage에서 이전 Chat_Panel 상태를 복원한다
3. WHEN 사용자가 다른 프로젝트의 Workspace_Page로 이동할 때, THE Chat_Panel 상태 SHALL 프로젝트 간에 공유되어 동일한 열림/닫힘 상태를 유지한다
