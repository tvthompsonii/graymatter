import type { ReactNode, SVGProps } from 'react'

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number }

/** Stroke icons (Lucide shapes) that inherit the text color; decorative unless labelled. */
function Icon({ size = 16, strokeWidth = 2, children, ...props }: IconProps & { children: ReactNode }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            {...props}
        >
            {children}
        </svg>
    )
}

export function BookIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z" />
            <path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z" />
        </Icon>
    )
}

export function PuzzleIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <path d="M19.44 7.85c-.05.32.06.65.29.88l1.57 1.57c.47.47.7 1.09.7 1.7s-.23 1.23-.7 1.7l-1.61 1.61a.98.98 0 0 1-.84.28c-.47-.07-.8-.48-.97-.93a2.5 2.5 0 1 0-3.21 3.21c.45.17.86.5.93.97a.98.98 0 0 1-.28.84l-1.61 1.61a2.4 2.4 0 0 1-3.4 0l-1.57-1.57a1.03 1.03 0 0 0-.88-.29c-.49.07-.84.5-1.02.97a2.5 2.5 0 1 1-3.24-3.24c.46-.18.9-.53.97-1.02a1.03 1.03 0 0 0-.29-.88l-1.57-1.57a2.4 2.4 0 0 1 0-3.4L4.23 8.77c.24-.24.58-.35.92-.3.51.08.88.53 1.07 1.01a2.5 2.5 0 1 0 3.26-3.26c-.48-.2-.93-.56-1.01-1.07-.05-.34.06-.68.3-.92l1.53-1.53a2.4 2.4 0 0 1 3.4 0l1.57 1.57c.23.23.56.34.88.29.49-.07.84-.5 1.02-.97a2.5 2.5 0 1 1 3.24 3.24c-.46.18-.9.53-.97 1.02Z" />
        </Icon>
    )
}

export function SwordsIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5" />
            <line x1="13" x2="19" y1="19" y2="13" />
            <line x1="16" x2="20" y1="16" y2="20" />
            <line x1="19" x2="21" y1="21" y2="19" />
            <polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5" />
            <line x1="5" x2="9" y1="14" y2="18" />
            <line x1="7" x2="4" y1="17" y2="20" />
            <line x1="3" x2="5" y1="19" y2="21" />
        </Icon>
    )
}

export function InfoIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
        </Icon>
    )
}

export function LightbulbIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
            <path d="M9 18h6" />
            <path d="M10 22h4" />
        </Icon>
    )
}

export function ResetIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
        </Icon>
    )
}

export function UndoIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11" />
        </Icon>
    )
}

export function SkipIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <polygon points="5 4 15 12 5 20 5 4" />
            <line x1="19" x2="19" y1="5" y2="19" />
        </Icon>
    )
}

export function PlayIcon(props: IconProps) {
    return (
        <Icon fill="currentColor" stroke="none" {...props}>
            <polygon points="6 3 20 12 6 21 6 3" />
        </Icon>
    )
}

export function PlusIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <path d="M5 12h14" />
            <path d="M12 5v14" />
        </Icon>
    )
}

export function XIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
        </Icon>
    )
}

export function CheckIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <path d="M20 6 9 17l-5-5" />
        </Icon>
    )
}

export function LockIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <rect width="18" height="11" x="3" y="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </Icon>
    )
}

export function ExternalLinkIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <path d="M15 3h6v6" />
            <path d="M10 14 21 3" />
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        </Icon>
    )
}

export function BotIcon(props: IconProps) {
    return (
        <Icon {...props}>
            <rect width="16" height="12" x="4" y="8" rx="2" />
            <path d="M12 8V4H8" />
            <path d="M2 14h2" />
            <path d="M20 14h2" />
            <path d="M15 13v2" />
            <path d="M9 13v2" />
        </Icon>
    )
}
