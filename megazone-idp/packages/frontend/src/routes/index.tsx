import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAwsClient } from '../hooks/useAwsClient';
import CubeLoader from '../components/CubeLoader';
import ProjectExplorer from '../components/ProjectExplorer';
import { Project } from '../components/ProjectSettingsModal';

export const Route = createFileRoute('/')({
  component: LandingPage,
});

function LandingPage() {
  const navigate = useNavigate();
  const { fetchApi } = useAwsClient();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const startedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const list = await fetchApi<Project[]>('projects');
      if (list.length === 0) {
        // No projects yet: auto-provision the default workspace and open it.
        const created = await fetchApi<Project>('projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '내 자료실' }),
        });
        navigate({
          to: '/projects/$projectId',
          params: { projectId: created.project_id },
          replace: true,
        });
        return;
      }
      setProjects(list);
    } catch (error) {
      console.error('Failed to load projects:', error);
      setProjects([]);
    }
  }, [fetchApi, navigate]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    load();
  }, [load]);

  if (!projects || projects.length === 0) {
    return (
      <div className="bento-page">
        <div className="bento-loading">
          <CubeLoader />
        </div>
      </div>
    );
  }

  return (
    <ProjectExplorer
      key={projects.map((p) => p.project_id).join(',')}
      initialProjects={projects}
      onProjectsChanged={load}
    />
  );
}
