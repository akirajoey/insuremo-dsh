/** Plugin-owned button atom (TASK-168a): no Harness Client value imports. */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import css from "./Button.module.css";

export type ButtonVariant = "primary" | "ghost" | "outline" | "toolbar";

type ButtonProps = {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  icon?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>;

/** Token-styled button; always `type="button"` unless the caller overrides it. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = "ghost",
  size = "md",
  icon,
  className,
  children,
  ...rest
}, ref) {
  const classes = [css.button, css[variant], css[size], className].filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
  return (
    <button {...rest} ref={ref} type="button" className={classes}>
      {icon != null && <span className={css.icon} aria-hidden="true">{icon}</span>}
      {children}
    </button>
  );
});
