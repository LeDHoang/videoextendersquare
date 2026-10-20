import { Suspense, lazy } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import AppShell from './components/layout/AppShell.jsx';
import { SectionSkeleton } from './components/ui/Skeleton.jsx';
import RequireAuth from './components/auth/RequireAuth.jsx';
import { useDocumentTitle, routeTitle } from './hooks/useDocumentTitle.js';

const ImagePage = lazy(() => import('./pages/ImagePage.jsx'));
const VideoPage = lazy(() => import('./pages/VideoPage.jsx'));
const ComparePage = lazy(() => import('./pages/ComparePage.jsx'));
const ReelsPage = lazy(() => import('./pages/ReelsPage.jsx'));
const ImmersivePreviewPage = lazy(() => import('./pages/ImmersivePreviewPage.jsx'));
const ExplorePage = lazy(() => import('./pages/ExplorePage.jsx'));
const TagExplorePage = lazy(() => import('./pages/TagExplorePage.jsx'));
const LocationExplorePage = lazy(() => import('./pages/LocationExplorePage.jsx'));
const UploadPage = lazy(() => import('./pages/UploadPage.jsx'));
const AuthPage = lazy(() => import('./pages/AuthPage.jsx'));
const ProfilePage = lazy(() => import('./pages/ProfilePage.jsx'));
const PackPage = lazy(() => import('./pages/PackPage.jsx'));
const PackEditorPage = lazy(() => import('./pages/PackEditorPage.jsx'));
const ProfileSettingsPage = lazy(() => import('./pages/ProfileSettingsPage.jsx'));
const MessagesPage = lazy(() => import('./pages/MessagesPage.jsx'));
const WalletPage = lazy(() => import('./pages/WalletPage.jsx'));

const PasswordResetPage = lazy(() => import('./pages/PasswordResetPage.jsx'));
const ModerationPage = lazy(() => import('./pages/ModerationPage.jsx'));
const TermsPage = lazy(() => import('./pages/TermsPage.jsx'));
const PrivacyPage = lazy(() => import('./pages/PrivacyPage.jsx'));
const RulesPage = lazy(() => import('./pages/RulesPage.jsx'));
export default function App() {
  const { pathname } = useLocation();
  useDocumentTitle(routeTitle(pathname));
  return (
    <Suspense fallback={<SectionSkeleton label="Loading page" />}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/reels" replace />} />
          <Route path="/image" element={<RequireAuth><ImagePage /></RequireAuth>} />
          <Route path="/video" element={<RequireAuth><VideoPage /></RequireAuth>} />
          <Route path="/compare" element={<RequireAuth><ComparePage /></RequireAuth>} />
          <Route path="/reels" element={<ReelsPage />} />
          <Route path="/reels/immersive-preview" element={<RequireAuth><ImmersivePreviewPage /></RequireAuth>} />
          <Route path="/explore" element={<ExplorePage />} />
          <Route path="/explore/tag/:tag" element={<TagExplorePage />} />
          <Route path="/explore/location/:key" element={<LocationExplorePage />} />
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/signup" element={<AuthPage mode="register" />} />
          <Route path="/forgot-password" element={<PasswordResetPage requestOnly />} />
          <Route path="/reset-password" element={<PasswordResetPage />} />
          <Route path="/profile/:username" element={<ProfilePage />} />
          <Route path="/packs/new" element={<RequireAuth><PackEditorPage /></RequireAuth>} />
          <Route path="/packs/:packId/edit" element={<RequireAuth><PackEditorPage /></RequireAuth>} />
          <Route path="/packs/:packId" element={<PackPage />} />
          <Route path="/settings/profile" element={<RequireAuth><ProfileSettingsPage /></RequireAuth>} />
          <Route path="/messages" element={<RequireAuth><MessagesPage /></RequireAuth>} />
          <Route path="/wallet" element={<RequireAuth><WalletPage /></RequireAuth>} />
          <Route path="/messages/:conversationId" element={<RequireAuth><MessagesPage /></RequireAuth>} />
          <Route path="/upload" element={<RequireAuth><UploadPage /></RequireAuth>} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/rules" element={<RulesPage />} />
          <Route path="/moderation" element={<RequireAuth><ModerationPage /></RequireAuth>} />
          <Route path="*" element={<Navigate to="/reels" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
