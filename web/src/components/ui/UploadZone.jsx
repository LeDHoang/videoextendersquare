import { useRef, useState } from 'react';

export default function UploadZone({ accept, multiple = true, onFiles, caption }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const handleFiles = (list) => {
    const files = Array.from(list || []);
    if (files.length) onFiles(files);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      inputRef.current?.click();
    }
  };

  return (
    <div
      className={`sx-upload-zone ${dragging ? 'sx-dragging' : ''}`}
      role="button"
      tabIndex={0}
      aria-label="Upload media. Drop files here or press Enter to browse files."
      onClick={() => inputRef.current?.click()}
      onKeyDown={handleKeyDown}
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
      <div className="sx-upload-icon" aria-hidden="true">
        ⇪
      </div>
      <div className="sx-upload-title">
        DROP SOURCE FILES OR CLICK TO BROWSE
      </div>
      <div className="sx-upload-caption">{caption}</div>
    </div>
  );
}