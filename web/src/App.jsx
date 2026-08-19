import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './components/layout/AppShell.jsx';
import ImagePage from './pages/ImagePage.jsx';
import VideoPage from './pages/VideoPage.jsx';
import ComparePage from './pages/ComparePage.jsx';
import ReelsPage from './pages/ReelsPage.jsx';

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/image" replace />} />
        <Route path="/image" element={<ImagePage />} />
        <Route path="/video" element={<VideoPage />} />
        <Route path="/compare" element={<ComparePage />} />
        <Route path="/reels" element={<ReelsPage />} />
        <Route path="*" element={<Navigate to="/image" replace />} />
      </Route>
    </Routes>
  );
}