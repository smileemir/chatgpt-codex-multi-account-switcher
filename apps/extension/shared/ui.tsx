import { useEffect, useId, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type ReactNode } from "react";
import { getLanguage, languages, saveLanguage, subscribeLanguage, t, type Language } from "./i18n";

export function useLanguage(): Language {
  return useSyncExternalStore(subscribeLanguage, getLanguage);
}

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const language = useLanguage();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [saveError, setSaveError] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listId = useId();
  const selected = languages.find((item) => item.code === language)!;

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside, true);
    return () => document.removeEventListener("pointerdown", closeOutside, true);
  }, [open]);

  function openList() {
    setActiveIndex(languages.findIndex((item) => item.code === language));
    setSaveError(false);
    setOpen(true);
  }

  async function choose(next: Language) {
    try {
      await saveLanguage(next);
      setSaveError(false);
      setOpen(false);
      buttonRef.current?.focus();
    } catch {
      setSaveError(true);
    }
  }

  function move(delta: number) {
    setActiveIndex((index) => (index + delta + languages.length) % languages.length);
  }

  return (
    <div ref={rootRef} className={`cma-language-switcher ${compact ? "cma-language-switcher--compact" : ""}`} onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button ref={buttonRef} type="button" className="cma-language-trigger" aria-label={`${t("languageLabel")}: ${selected.name}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => open ? setOpen(false) : openList()} onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openList(); }
      }}>
        <svg className="cma-language-globe" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c-3 3-4 6-4 9s1 6 4 9M12 3c3 3 4 6 4 9s-1 6-4 9" /></svg>
        <span>{compact ? language.split("_")[0].toUpperCase() : selected.name}</span>
        <svg className="cma-language-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m3 6 5 5 5-5" /></svg>
      </button>
      {open && <div id={listId} className="cma-language-menu" role="listbox" aria-label={t("languageLabel")} onKeyDown={(event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
        else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
        else if (event.key === "Home") { event.preventDefault(); setActiveIndex(0); }
        else if (event.key === "End") { event.preventDefault(); setActiveIndex(languages.length - 1); }
        else if (event.key === "Escape") { event.preventDefault(); setOpen(false); buttonRef.current?.focus(); }
        else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
          const start = (activeIndex + 1) % languages.length;
          for (let offset = 0; offset < languages.length; offset++) {
            const index = (start + offset) % languages.length;
            if (languages[index].name.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase())) {
              setActiveIndex(index);
              break;
            }
          }
        }
      }}>
        {languages.map(({ code, name }, index) => <button key={code} ref={(node) => { optionRefs.current[index] = node; }} type="button" role="option" aria-selected={language === code} tabIndex={index === activeIndex ? 0 : -1} className="cma-language-option" onClick={() => void choose(code)}>
          <span className="cma-language-option-code">{code.toUpperCase()}</span><span>{name}</span><span className="cma-language-check" aria-hidden="true">{language === code ? "✓" : ""}</span>
        </button>)}
        {saveError && <p className="cma-language-error" role="alert">{t("languageSaveFailed")}</p>}
      </div>}
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

export function Button({
  variant = "secondary",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      className={`cma-button cma-button--${variant} ${className}`.trim()}
      {...props}
    >
      {children}
    </button>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`cma-brand ${compact ? "cma-brand--compact" : ""}`}>
      <span className="cma-brand-mark" aria-hidden="true"><span /></span>
      <span className="cma-brand-copy">
        <strong title={t("extensionName")}>{t("extensionName")}</strong>
        {!compact && <small>{t("brandTagline")}</small>}
      </span>
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  return <span className={`cma-badge cma-badge--${tone}`}>{children}</span>;
}

export function Notice({ title, children, tone = "neutral", action }: {
  title?: string;
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad";
  action?: ReactNode;
}) {
  return (
    <div className={`cma-notice cma-notice--${tone}`} role={tone === "bad" ? "alert" : "status"}>
      <div>
        {title && <strong>{title}</strong>}
        <div>{children}</div>
      </div>
      {action}
    </div>
  );
}

export function Dialog({ title, children, onClose, actions, className = "" }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  actions?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    const previousOverflow = document.documentElement.style.overflow;
    dialog?.showModal();
    document.documentElement.style.overflow = "hidden";
    (dialog?.querySelector<HTMLElement>("[autofocus]") ?? titleRef.current)?.focus();
    return () => {
      dialog?.close();
      document.documentElement.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`cma-dialog ${className}`.trim()}
      aria-labelledby="dialog-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
    >
      <div className="cma-dialog-header">
        <h2 id="dialog-title" tabIndex={-1} ref={titleRef}>{title}</h2>
        <Button variant="quiet" className="cma-icon-button" onClick={onClose} aria-label={t("close")}>×</Button>
      </div>
      <div className="cma-dialog-body">{children}</div>
      {actions && <div className="cma-dialog-actions">{actions}</div>}
    </dialog>
  );
}

export function Feedback({ message, tone, onDismiss }: {
  message: string;
  tone: "good" | "bad";
  onDismiss: () => void;
}) {
  return (
    <div className={`cma-feedback cma-feedback--${tone}`} role={tone === "bad" ? "alert" : "status"}>
      <span>{message}</span>
      <Button variant="quiet" className="cma-icon-button" onClick={onDismiss} aria-label={t("close")}>×</Button>
    </div>
  );
}
