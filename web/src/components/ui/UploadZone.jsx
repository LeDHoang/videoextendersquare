import { useRef, useState } from 'react';
import Emoji from './Emoji.jsx';

export default function UploadZone({ accept, multiple = true, onFiles, caption }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const handleFiles = (list) => {
    const files = Array.from(list || []);
    if (files.length) onFiles(files);
  };

  return (
    <div
      className={`sx-upload-zone ${dragging ? 'sx-dragging' : ''}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        style={{ display: 'none' }}
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <p style={{ fontWeight: 700, color: 'var(--sx-ink)', fontSize: '1rem', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
        Drop files or click to browse
      </p>
      <p>{caption}</p>
    </div>
  );
}