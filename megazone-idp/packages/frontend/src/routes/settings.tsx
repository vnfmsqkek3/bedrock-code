import { createFileRoute, Navigate } from '@tanstack/react-router';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

// R1/F5: the settings page exposes AWS concepts (SageMaker, endpoints, license).
// Hidden from end users — the route stays registered but redirects home.
function SettingsPage() {
  return <Navigate to="/" replace />;
}
