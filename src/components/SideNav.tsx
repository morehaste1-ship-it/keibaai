import React, { useEffect, useState } from 'react';
import { List, X } from 'lucide-react';

export interface NavItem {
  /** 移動先の要素の id */
  id: string;
  label: string;
  /** 見出し（「このレース」「管理」など）。同じ見出しの項目をまとめて表示する */
  group: string;
  /** 一段下げて表示する（タブなど） */
  indent?: boolean;
  /** 押したときに移動の前に行う処理（タブを開くなど） */
  onSelect?: () => void;
  /** 今開いているタブなど、強調する項目 */
  current?: boolean;
}

/** 画面上部の固定ヘッダーの高さ（移動したときに見出しが隠れないように差し引く） */
function headerHeight(): number {
  const h = document.querySelector('header');
  return h ? h.getBoundingClientRect().height : 0;
}

export function scrollToSection(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - headerHeight() - 8;
  window.scrollTo({ top, behavior: 'smooth' });
}

/** 左の目次（広い画面では左に固定、狭い画面では右下のボタンで開閉） */
export const SideNav: React.FC<{ items: NavItem[] }> = ({ items }) => {
  const [active, setActive] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState(0);

  // ヘッダーの高さに合わせて、目次の上端をそろえる
  useEffect(() => {
    const update = () => setTop(headerHeight());
    update();
    window.addEventListener('resize', update);
    const h = document.querySelector('header');
    const ro = h && 'ResizeObserver' in window ? new ResizeObserver(update) : null;
    if (h && ro) ro.observe(h);
    return () => {
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
  }, []);

  // 今見ている欄（ヘッダーのすぐ下に来ている欄）を強調する
  const ids = [...new Set(items.map((i) => i.id))].join('|');
  useEffect(() => {
    const onScroll = () => {
      const line = headerHeight() + 80;
      const present = ids.split('|').filter((id) => document.getElementById(id));
      let current: string | null = present[0] ?? null;
      for (const id of present) {
        if ((document.getElementById(id) as HTMLElement).getBoundingClientRect().top <= line) current = id;
      }
      // いちばん下までスクロールしたときは、最後の欄を強調する（短い欄はヘッダーの下まで来ないため）
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = present[present.length - 1] ?? current;
      setActive(current);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    // データの読み込みなどで欄の高さが変わったときも、強調し直す
    const ro = 'ResizeObserver' in window ? new ResizeObserver(onScroll) : null;
    ro?.observe(document.body);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      ro?.disconnect();
    };
  }, [ids]);

  const groups = [...new Set(items.map((i) => i.group))];
  const go = (item: NavItem) => {
    item.onSelect?.();
    setOpen(false);
    // タブを開いた直後に移動すると高さが変わるため、描画を待ってから移動する
    requestAnimationFrame(() => scrollToSection(item.id));
  };

  const list = (
    <nav aria-label="目次" className="flex flex-col gap-3 text-xs">
      {groups.map((g) => (
        <div key={g}>
          <p className="px-2 mb-1 text-[10px] font-bold tracking-wider text-slate-500">{g}</p>
          <ul className="flex flex-col">
            {items
              .filter((i) => i.group === g)
              .map((i) => {
                // 今見ている欄を強調する。タブ（一段下げた項目）は、その欄を見ていて、かつ開いているタブだけ
                const highlight = active === i.id && (!i.indent || !!i.current);
                return (
                  <li key={`${i.id}-${i.label}`}>
                    <button
                      onClick={() => go(i)}
                      className={`w-full text-left py-1.5 rounded-md transition ${i.indent ? 'pl-5 pr-2' : 'px-2'} ${
                        highlight
                          ? 'bg-emerald-500/15 text-emerald-200 font-bold'
                          : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                      }`}
                    >
                      {i.label}
                    </button>
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <>
      {/* 広い画面：左に固定 */}
      <aside
        className="hidden lg:block w-52 shrink-0 sticky self-start overflow-y-auto border-r border-slate-800 py-4 pr-2 pl-3"
        style={{ top, maxHeight: `calc(100vh - ${top}px)` }}
      >
        {list}
      </aside>

      {/* 狭い画面：右下のボタンで開閉 */}
      <button
        onClick={() => setOpen(true)}
        className="lg:hidden fixed bottom-4 right-4 z-50 flex items-center gap-1.5 px-3 py-2 rounded-full bg-emerald-600 text-white text-xs font-bold shadow-lg"
      >
        <List className="w-4 h-4" />
        目次
      </button>
      {open && (
        <div className="lg:hidden fixed inset-0 z-50 bg-black/60" onClick={() => setOpen(false)}>
          <div
            className="absolute right-0 top-0 bottom-0 w-64 bg-slate-950 border-l border-slate-800 p-4 overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-black text-white">目次</p>
              <button onClick={() => setOpen(false)} className="p-1 text-slate-400 hover:text-white" aria-label="閉じる">
                <X className="w-4 h-4" />
              </button>
            </div>
            {list}
          </div>
        </div>
      )}
    </>
  );
};
