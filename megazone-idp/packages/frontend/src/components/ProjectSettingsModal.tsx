import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Info, Hash, Type, AlignLeft, Globe } from 'lucide-react';
import { useModal } from '../hooks/useModal';

export interface Project {
  project_id: string;
  name: string;
  description: string;
  status: string;
  created_by?: string | null;
  language: string | null;
  color: number | null;
  document_prompt?: string | null;
  started_at?: string;
  created_at?: string;
  updated_at?: string | null;
  ended_at?: string | null;
}

export const LANGUAGES = [
  { code: 'ko', name: 'Korean', flag: 'KR' },
  { code: 'ja', name: 'Japanese', flag: 'JP' },
  { code: 'zh', name: 'Chinese', flag: 'CN' },
  { code: 'zh-tw', name: 'Chinese (Traditional)', flag: 'TW' },
  { code: 'en', name: 'English', flag: 'US' },
  { code: 'fr', name: 'French', flag: 'FR' },
  { code: 'de', name: 'German', flag: 'DE' },
  { code: 'it', name: 'Italian', flag: 'IT' },
  { code: 'es', name: 'Spanish', flag: 'ES' },
  { code: 'pt', name: 'Portuguese', flag: 'PT' },
  { code: 'nl', name: 'Dutch', flag: 'NL' },
  { code: 'pl', name: 'Polish', flag: 'PL' },
  { code: 'ru', name: 'Russian', flag: 'RU' },
  { code: 'uk', name: 'Ukrainian', flag: 'UA' },
  { code: 'cs', name: 'Czech', flag: 'CZ' },
  { code: 'hu', name: 'Hungarian', flag: 'HU' },
  { code: 'ro', name: 'Romanian', flag: 'RO' },
  { code: 'bg', name: 'Bulgarian', flag: 'BG' },
  { code: 'sv', name: 'Swedish', flag: 'SE' },
  { code: 'no', name: 'Norwegian', flag: 'NO' },
  { code: 'da', name: 'Danish', flag: 'DK' },
  { code: 'fi', name: 'Finnish', flag: 'FI' },
  { code: 'vi', name: 'Vietnamese', flag: 'VN' },
  { code: 'th', name: 'Thai', flag: 'TH' },
  { code: 'id', name: 'Indonesian', flag: 'ID' },
  { code: 'ms', name: 'Malay', flag: 'MY' },
  { code: 'tl', name: 'Tagalog', flag: 'PH' },
  { code: 'hi', name: 'Hindi', flag: 'IN' },
  { code: 'bn', name: 'Bengali', flag: 'BD' },
  { code: 'ne', name: 'Nepali', flag: 'NP' },
  { code: 'ar', name: 'Arabic', flag: 'SA' },
  { code: 'fa', name: 'Persian', flag: 'IR' },
  { code: 'tr', name: 'Turkish', flag: 'TR' },
  { code: 'he', name: 'Hebrew', flag: 'IL' },
  { code: 'mn', name: 'Mongolian', flag: 'MN' },
  { code: 'sw', name: 'Swahili', flag: 'KE' },
];

// Muted neutral palette — 8 distinguishable tones, low saturation (Workbench)
export const CARD_COLORS = [
  {
    border: '#8189a3',
    glow: 'rgba(129,137,163,0.14)',
    back: '#8189a3',
    tab: '#6b7490',
    front: '#9aa1b8',
  }, // slate-blue
  {
    border: '#9184ab',
    glow: 'rgba(145,132,171,0.14)',
    back: '#9184ab',
    tab: '#7a6d96',
    front: '#a89dbf',
  }, // muted violet
  {
    border: '#8a9a86',
    glow: 'rgba(138,154,134,0.14)',
    back: '#8a9a86',
    tab: '#748471',
    front: '#a3b09f',
  }, // sage
  {
    border: '#b3a07d',
    glow: 'rgba(179,160,125,0.14)',
    back: '#b3a07d',
    tab: '#9a8867',
    front: '#c6b598',
  }, // tan
  {
    border: '#ab8fa0',
    glow: 'rgba(171,143,160,0.14)',
    back: '#ab8fa0',
    tab: '#937a89',
    front: '#bfa6b6',
  }, // mauve
  {
    border: '#7f9a9a',
    glow: 'rgba(127,154,154,0.14)',
    back: '#7f9a9a',
    tab: '#688484',
    front: '#98b0b0',
  }, // dusty teal
  {
    border: '#8a8bab',
    glow: 'rgba(138,139,171,0.14)',
    back: '#8a8bab',
    tab: '#737497',
    front: '#a2a3c0',
  }, // periwinkle
  {
    border: '#b18a86',
    glow: 'rgba(177,138,134,0.14)',
    back: '#b18a86',
    tab: '#98726e',
    front: '#c6a29e',
  }, // clay
];

interface FormData {
  name: string;
  description: string;
  language: string;
  color: number;
}

interface ProjectSettingsModalProps {
  project: Project | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: {
    name: string;
    description: string;
    language: string;
    color: number;
    document_prompt: string;
  }) => Promise<void>;
  isCreating?: boolean;
}

export default function ProjectSettingsModal({
  project,
  isOpen,
  onClose,
  onSave,
  isCreating = false,
}: ProjectSettingsModalProps) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);

  const [formData, setFormData] = useState<FormData>({
    name: '',
    description: '',
    language: 'en',
    color: 0,
  });

  useEffect(() => {
    if (project) {
      setFormData({
        name: project.name,
        description: project.description || '',
        language: project.language || 'en',
        color: project.color ?? 0,
      });
    } else {
      setFormData({
        name: '',
        description: '',
        language: 'en',
        color: 0,
      });
    }
  }, [project, isOpen]);

  const handleSave = async () => {
    if (!formData.name.trim()) return;

    setSaving(true);
    try {
      // R1/F5: color auto-preserved (no picker); analysis prompt kept as-is.
      await onSave({
        name: formData.name.trim(),
        description: formData.description.trim(),
        language: formData.language,
        color: formData.color,
        document_prompt: project?.document_prompt || '',
      });
      onClose();
    } catch (error) {
      console.error('Failed to save project:', error);
    } finally {
      setSaving(false);
    }
  };

  useModal({ isOpen, onClose });

  if (!isOpen) return null;

  const modalColor = CARD_COLORS[formData.color] || CARD_COLORS[0];

  return (
    <div className="bento-modal-overlay">
      <div
        className="bento-modal"
        style={
          {
            width: '740px',
            height: '680px',
            '--modal-glow-color': modalColor.border,
          } as React.CSSProperties
        }
      >
        {/* Header */}
        <h2 className="bento-modal-title">
          {isCreating ? t('projects.createProject') : t('projects.editProject')}
        </h2>

        {/* Body */}
        <div className="bento-settings-body">
          <div className="bento-settings-content">
            <div className="bento-modal-form">
              {project && !isCreating && (
                <div className="bento-form-group">
                  <label className="bento-form-label">
                    <Hash size={14} />
                    {t('projects.projectId')}
                  </label>
                  <div className="bento-form-readonly">
                    {project.project_id}
                  </div>
                </div>
              )}

              <div className="bento-form-group">
                <label className="bento-form-label">
                  <Type size={14} />
                  {t('projects.projectName')}
                </label>
                <input
                  data-modal-input
                  type="text"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                  placeholder={t('projects.projectNamePlaceholder')}
                  className="bento-form-input"
                />
              </div>

              <div className="bento-form-group">
                <label className="bento-form-label">
                  <AlignLeft size={14} />
                  {t('projects.description')}
                </label>
                <textarea
                  data-modal-input
                  value={formData.description}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      description: e.target.value,
                    })
                  }
                  placeholder={t('projects.descriptionPlaceholder')}
                  rows={3}
                  className="bento-form-textarea"
                />
              </div>

              <div className="bento-form-group">
                <label className="bento-form-label">
                  <Globe size={14} />
                  {t('common.language')}
                  <span className="bento-tooltip-wrapper">
                    <Info className="bento-tooltip-icon" size={14} />
                    <span className="bento-tooltip">
                      {t('projects.languageTooltip')}
                    </span>
                  </span>
                </label>
                <select
                  data-modal-input
                  value={formData.language}
                  onChange={(e) =>
                    setFormData({ ...formData, language: e.target.value })
                  }
                  className="bento-form-select"
                >
                  {LANGUAGES.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {t(`languages.${lang.code}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div
          className="bento-modal-footer"
          style={{ justifyContent: 'flex-end' }}
        >
          <div className="bento-modal-actions">
            <button onClick={onClose} className="bento-btn-cancel">
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={!formData.name.trim() || saving}
              className="bento-btn-save"
            >
              {saving
                ? t('common.saving')
                : isCreating
                  ? t('common.create')
                  : t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
