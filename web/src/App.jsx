import { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './components/layout/AppShell.jsx';
import { SectionSkeleton } from './components/ui/Skeleton.jsx';

const ImagePage = lazy(() => import('./pages/ImagePage.jsx'));
const VideoPage = lazy(() => import('./pages/VideoPage.jsx'));
const ComparePage = lazy(() => import('./pages/ComparePage.jsx'));
const ReelsPage = lazy(() => import('./pages/ReelsPage.jsx'));
const ExplorePage = lazy(() => import('./pages/ExplorePage.jsx'));
const TagExplorePage = lazy(() => import('./pages/TagExplorePage.jsx'));
const UploadPage = lazy(() => import('./pages/UploadPage.jsx'));

export default function App() {
  return (
    <Suspense fallback={<SectionSkeleton label="Loading page" />}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/reels" replace />} />
          <Route path="/image" element={<ImagePage />} />
          <Route path="/video" element={<VideoPage />} />
          <Route path="/compare" element={<ComparePage />} />
          <Route path="/reels" element={<ReelsPage />} />
          <Route path="/explore" element={<ExplorePage />} />
          <Route path="/explore/tag/:tag" element={<TagExplorePage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="*" element={<Navigate to="/reels" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}