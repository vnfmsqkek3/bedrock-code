import { useTranslation } from 'react-i18next';
import type { GraphData } from './useGraphData';
import {
  LINK_TYPE_COLORS,
  DOCUMENT_COLOR,
  SEGMENT_COLOR,
  ANALYSIS_COLOR,
  ORIGIN_SEGMENT_COLOR,
  getEntityColor,
} from './constants';

interface GraphSidePanelProps {
  documentName?: string;
  data: GraphData;
  depth: number;
  onDepthChange: (depth: number) => void;
  maxDepth?: number;
  linkTypes: string[];
  hiddenLinkTypes: Set<string>;
  onToggleLinkType: (type: string) => void;
}

function ToggleSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      onClick={onChange}
      className={`relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0 cursor-pointer ${
        checked ? 'bg-[#7c3aed]' : 'bg-[#e7e2db] dark:bg-[#363b50]'
      }`}
    >
      <span
        className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'left-[16px]' : 'left-[2px]'
        }`}
      />
    </button>
  );
}

function StatTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div
      className={`flex-1 rounded-xl border p-2.5 text-center ${
        accent
          ? 'border-[#c9b8ef] dark:border-[#4a3a70] bg-[#f2eefb] dark:bg-[#2a1f45]'
          : 'border-[var(--color-border)] dark:border-[#363b50] bg-white dark:bg-[#1a1f2e]'
      }`}
    >
      <div
        className={`text-base font-semibold tabular-nums ${
          accent
            ? 'text-[#7c3aed] dark:text-violet-400'
            : 'text-[#1a1523] dark:text-slate-100'
        }`}
      >
        {value}
      </div>
      <div className="text-[10px] text-[#6b6478] dark:text-slate-500 mt-0.5">
        {label}
      </div>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
        style={{ backgroundColor: color }}
      />
      <span className="text-[11px] text-[#3a3350] dark:text-slate-300 truncate">
        {label}
      </span>
    </div>
  );
}

export default function GraphSidePanel({
  documentName,
  data,
  depth,
  onDepthChange,
  maxDepth = 6,
  linkTypes,
  hiddenLinkTypes,
  onToggleLinkType,
}: GraphSidePanelProps) {
  const { t } = useTranslation();
  const entityCount = data.nodes.filter((n) => n.label === 'entity').length;
  const depthPct = ((depth - 1) / (maxDepth - 1)) * 100;

  return (
    <div className="w-[300px] flex-shrink-0 overflow-y-auto bg-[var(--color-panel)] dark:bg-[#1a1f2e] border-l border-[var(--color-border)] dark:border-[#363b50] p-4 space-y-4">
      {/* Header */}
      <div className="flex items-start gap-2.5">
        <span className="w-2.5 h-2.5 mt-1 rounded-sm bg-[#7c3aed] flex-shrink-0" />
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-[#1a1523] dark:text-slate-100">
            {t('workflow.graph.title', 'Knowledge Graph')}
          </div>
          {documentName && (
            <div className="text-[11px] text-[#a89fb8] dark:text-slate-600 truncate">
              {documentName}
            </div>
          )}
        </div>
      </div>

      {/* Stat tiles */}
      <div className="flex gap-2">
        <StatTile
          label={t('workflow.graph.nodes', 'Nodes')}
          value={data.nodes.length}
        />
        <StatTile
          label={t('workflow.graph.edges', 'Edges')}
          value={data.edges.length}
        />
        <StatTile
          label={t('workflow.graph.entities', 'Entities')}
          value={entityCount}
          accent
        />
      </div>

      {/* Depth */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[12px] font-medium text-[#3a3350] dark:text-slate-300">
            {t('workflow.graph.depth', 'Depth')}
          </span>
          <span className="text-[11px] font-semibold text-[#7c3aed] dark:text-violet-300 bg-[#f2eefb] dark:bg-[#2a1f45] rounded-full px-2 py-0.5 tabular-nums">
            {depth}
          </span>
        </div>
        <input
          type="range"
          min={1}
          max={maxDepth}
          value={depth}
          onChange={(e) => onDepthChange(Number(e.target.value))}
          style={{
            background: `linear-gradient(to right, #7c3aed ${depthPct}%, var(--graph-panel-track, #e7e2db) ${depthPct}%)`,
          }}
          className="w-full h-1 appearance-none rounded-full cursor-pointer dark:[--graph-panel-track:#363b50] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-[#7c3aed] [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer"
        />
      </div>

      {/* Link types */}
      {linkTypes.length > 0 && (
        <div>
          <div className="text-[12px] font-medium text-[#3a3350] dark:text-slate-300 mb-1.5">
            {t('workflow.graph.linkTypes', 'Link Types')}
          </div>
          <div className="space-y-1.5">
            {linkTypes.map((type) => {
              const color = LINK_TYPE_COLORS[type] ?? '#6b7280';
              const active = !hiddenLinkTypes.has(type);
              return (
                <div
                  key={type}
                  className={`flex items-center justify-between transition-opacity ${active ? '' : 'opacity-40'}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-3 h-0.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: color }}
                    />
                    <span className="text-[12px] text-[#3a3350] dark:text-slate-300 truncate">
                      {type}
                    </span>
                  </div>
                  <ToggleSwitch
                    checked={active}
                    onChange={() => onToggleLinkType(type)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Legend */}
      <div>
        <div className="text-[12px] font-medium text-[#3a3350] dark:text-slate-300 mb-1.5">
          {t('workflow.graph.legend', 'Node Legend')}
        </div>
        <div className="grid grid-cols-2 gap-y-1.5 gap-x-2">
          <LegendItem
            color={DOCUMENT_COLOR}
            label={t('workflow.graph.legendDocument', 'Document')}
          />
          <LegendItem
            color={SEGMENT_COLOR}
            label={t('workflow.graph.legendSegment', 'Segment')}
          />
          <LegendItem
            color={ANALYSIS_COLOR}
            label={t('workflow.graph.legendAnalysis', 'Analysis')}
          />
          <LegendItem
            color={getEntityColor()}
            label={t('workflow.graph.legendEntity', 'Entity')}
          />
          <LegendItem
            color={ORIGIN_SEGMENT_COLOR}
            label={t('workflow.graph.legendOrigin', 'Origin')}
          />
        </div>
      </div>
    </div>
  );
}
