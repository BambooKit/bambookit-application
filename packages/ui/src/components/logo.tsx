import { type ComponentProps } from "solid-js"

/**
 * BambooKit mark: a tilted bamboo stalk with three nodes and four leaves, drawn in a 100×100 box.
 * Uses theme icon colours so it works on light and dark themes.
 */
const Bamboo = (props: { fill: string; leaf?: string }) => (
  <g transform="rotate(14 50 50)">
    <path d="M45.5 12.5h10l-.8 23.2h-8.4z" fill={props.fill} />
    <path d="M46.4 38.2h8.2l-.6 21.4h-7.2z" fill={props.fill} />
    <path d="M46.9 62.1h7.1l.9 26.4h-9z" fill={props.fill} />
    <ellipse cx="50.5" cy="12.6" rx="5" ry="1.6" fill={props.fill} />
    <g fill={props.leaf ?? props.fill}>
      <path d="M45.6 36.4C38.4 29.6 31 26.4 21.6 25.8c8.6 3.4 15.4 7.4 24 10.6z" />
      <path d="M45.2 37.4C35.6 36.2 25.4 38.6 13.8 44.4c11.4-2.6 21.6-4.4 31.4-7z" />
      <path d="M46.6 35.6c-2.2-8.4-5.4-14.4-10.8-20.8 3.6 7.2 6.8 13.6 10.8 20.8z" />
      <path d="M55.2 61.4c8.6-5.8 17.2-8.8 27.6-9.4-9.4 3.8-17.6 6.8-27.6 9.4z" />
      <path d="M55.4 62.6c9.6.4 19 3.6 29.2 9.4-10.4-2.8-19.6-5.2-29.2-9.4z" />
    </g>
  </g>
)

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="BambooKit"
    >
      <svg x="-2" y="0" width="20" height="20" viewBox="0 0 100 100">
        <Bamboo fill="var(--icon-strong-base)" />
      </svg>
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="BambooKit"
    >
      <svg x="-10" y="0" width="100" height="100" viewBox="0 0 100 100">
        <Bamboo fill="var(--icon-strong-base)" />
      </svg>
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
      aria-label="BambooKit"
    >
      <svg x="0" y="0" width="42" height="42" viewBox="0 0 100 100">
        <Bamboo fill="var(--icon-strong-base)" />
      </svg>
      <text
        x="50"
        y="31"
        fill="var(--icon-strong-base)"
        style={{ "font-family": "inherit", "font-size": "28px", "font-weight": "600", "letter-spacing": "0.2px" }}
      >
        BambooKit
      </text>
    </svg>
  )
}
