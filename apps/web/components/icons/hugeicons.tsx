import {
  Activity01Icon as HugeActivityIcon,
  Add01Icon as HugePlusIcon,
  Analytics01Icon as HugeAnalyticsIcon,
  Alert02Icon as HugeTriangleAlertIcon,
  AlertCircleIcon as HugeCircleAlertIcon,
  ArrowRight02Icon as HugeArrowRightIcon,
  BellIcon as HugeBellIcon,
  BubbleChatIcon as HugeMessageSquareTextIcon,
  Cancel01Icon as HugeXIcon,
  CheckmarkCircle01Icon as HugeCheckCircleIcon,
  ChevronDoubleCloseIcon as HugeChevronDoubleCloseIcon,
  ChevronsLeftRightIcon as HugeChevronsLeftRightIcon,
  ChevronDownIcon as HugeChevronDownIcon,
  ArchiveArrowDownIcon as HugeArchiveArrowDownIcon,
  ChevronLeftIcon as HugeChevronLeftIcon,
  ChevronRightIcon as HugeChevronRightIcon,
  CircleFadingArrowUpIcon as HugeCircleFadingArrowUpIcon,
  ChevronUpIcon as HugeChevronUpIcon,
  ChevronsDownUpIcon as HugeChevronsUpDownIcon,
  Delete01Icon as HugeDeleteIcon,
  ExternalLinkIcon as HugeExternalLinkIcon,
  Flag03Icon as HugeFlagIcon,
  GithubIcon as HugeGithubIcon,
  GitPullRequestIcon as HugeGitPullRequestIcon,
  GoogleIcon as HugeGoogleIcon,
  CircleDashedIcon as HugeCircleDashedIcon,
  HeadsetConnectedIcon as HugeHeadsetIcon,
  CloudSlowWindIcon as HugeCloudSlowWindIcon,
  DatabaseSync01Icon as HugeDatabaseSyncIcon,
  DatabaseImportIcon as HugeDatabaseImportIcon,
  Home09Icon as HugeHomeIcon,
  InboxIcon as HugeInboxIcon,
  InformationCircleIcon as HugeInfoIcon,
  Layers01Icon as HugeLayersIcon,
  Link04Icon as HugeLinkIcon,
  LockIcon as HugeLockIcon,
  LottiefilesIcon as HugeLottiefilesIcon,
  ChartAnalysisIcon as HugeChartAnalysisIcon,
  Loading03Icon as HugeLoaderIcon,
  GrowwIcon as HugeGrowwIcon,
  Logout01Icon as HugeLogoutIcon,
  ActivityCircleIcon as HugeActivityCircleIcon,
  MenuCollapseIcon as HugePanelLeftIcon,
  MinusSignIcon as HugeMinusIcon,
  MoreHorizontalIcon as HugeMoreHorizontalIcon,
  MoreVerticalCircle01Icon as HugeMoreVerticalCircleIcon,
  News01Icon as HugeNewspaperIcon,
  PencilEdit02Icon as HugePencilEditIcon,
  PuzzleIcon as HugePuzzleIcon,
  ArrowUpRight03Icon as HugeArrowUpRightIcon,
  Pulse01Icon as HugePulseIcon,
  Exchange01Icon as HugeExchangeIcon,
  ChartNoAxesCombinedIcon as HugeChartNoAxesCombinedIcon,
  Analytics02Icon as HugeAnalytics02Icon,
  Rocket02Icon as HugeRocketIcon,
  CheckIcon as HugeCheckIcon,
  Search01Icon as HugeSearchIcon,
  Settings02Icon as HugeSettingsIcon,
  SparklesIcon as HugeSparklesIcon,
  StarIcon as HugeStarIcon,
  CircleIcon as HugeCircleIcon,
  StripeIcon as HugeStripeIcon,
  UserGroupIcon as HugeUsersIcon,
  UserCircleIcon as HugeUserCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type * as React from "react";

type IconProps = Omit<React.ComponentProps<typeof HugeiconsIcon>, "icon">;

function createIcon(icon: IconSvgElement): React.FC<IconProps> {
  function Icon({
    color = "currentColor",
    size = "1em",
    strokeWidth = 1.8,
    ...props
  }: IconProps): React.ReactElement {
    return (
      <HugeiconsIcon
        color={color}
        icon={icon}
        size={size}
        strokeWidth={strokeWidth}
        {...props}
      />
    );
  }

  return Icon;
}

export const ActivityIcon = createIcon(HugeActivityIcon as IconSvgElement);
export const AnalyticsIcon = createIcon(HugeAnalyticsIcon as IconSvgElement);
export const ArrowRightIcon = createIcon(HugeArrowRightIcon as IconSvgElement);
export const BellIcon = createIcon(HugeBellIcon as IconSvgElement);
export const CheckCircle2Icon = createIcon(
  HugeCheckCircleIcon as IconSvgElement,
);
export const CircleAlertIcon = createIcon(
  HugeCircleAlertIcon as IconSvgElement,
);
export const CircleCheckIcon = createIcon(
  HugeCheckCircleIcon as IconSvgElement,
);
export const DeleteIcon = createIcon(HugeDeleteIcon as IconSvgElement);
export const ChevronDoubleCloseIcon = createIcon(
  HugeChevronDoubleCloseIcon as IconSvgElement,
);
export const ChevronsLeftRightIcon = createIcon(
  HugeChevronsLeftRightIcon as IconSvgElement,
);
export const ChevronDownIcon = createIcon(
  HugeChevronDownIcon as IconSvgElement,
);
export const CircleIcon = createIcon(HugeCircleIcon as IconSvgElement);
export const CircleFadingArrowUpIcon = createIcon(
  HugeCircleFadingArrowUpIcon as IconSvgElement,
);
export const CircleDashedIcon = createIcon(
  HugeCircleDashedIcon as IconSvgElement,
);
export const CheckIcon = createIcon(HugeCheckIcon as IconSvgElement);
export const ChevronLeftIcon = createIcon(
  HugeChevronLeftIcon as IconSvgElement,
);
export const ChevronRight = createIcon(HugeChevronRightIcon as IconSvgElement);
export const ChevronRightIcon = createIcon(
  HugeChevronRightIcon as IconSvgElement,
);
export const Analytics02Icon = createIcon(HugeAnalytics02Icon as IconSvgElement);
export const GrowwIcon = createIcon(HugeGrowwIcon as IconSvgElement);
export const ChevronUpIcon = createIcon(HugeChevronUpIcon as IconSvgElement);
export const ChevronsUpDownIcon = createIcon(
  HugeChevronsUpDownIcon as IconSvgElement,
);
export const ArchiveArrowDownIcon = createIcon(
  HugeArchiveArrowDownIcon as IconSvgElement,
);
export const ChartAnalysisIcon = createIcon(
  HugeChartAnalysisIcon as IconSvgElement,
);
export const ActivityCircleIcon = createIcon(
  HugeActivityCircleIcon as IconSvgElement,
);
export const LottiefilesIcon = createIcon(HugeLottiefilesIcon as IconSvgElement);
export const ChartNoAxesCombinedIcon = createIcon(
  HugeChartNoAxesCombinedIcon as IconSvgElement,
);
export const ExternalLinkIcon = createIcon(
  HugeExternalLinkIcon as IconSvgElement,
);
export const FlagIcon = createIcon(HugeFlagIcon as IconSvgElement);
export const GithubIcon = createIcon(HugeGithubIcon as IconSvgElement);
export const GitPullRequestIcon = createIcon(
  HugeGitPullRequestIcon as IconSvgElement,
);
export const GoogleIcon = createIcon(HugeGoogleIcon as IconSvgElement);
export const HeadsetIcon = createIcon(HugeHeadsetIcon as IconSvgElement);
export const CloudSlowWindIcon = createIcon(
  HugeCloudSlowWindIcon as IconSvgElement,
);
export const DatabaseSync01Icon = createIcon(
  HugeDatabaseSyncIcon as IconSvgElement,
);
export const DatabaseImportIcon = createIcon(
  HugeDatabaseImportIcon as IconSvgElement,
);
export const HomeIcon = createIcon(HugeHomeIcon as IconSvgElement);
export const InboxIcon = createIcon(HugeInboxIcon as IconSvgElement);
export const InfoIcon = createIcon(HugeInfoIcon as IconSvgElement);
export const Layers3Icon = createIcon(HugeLayersIcon as IconSvgElement);
export const LinkIcon = createIcon(HugeLinkIcon as IconSvgElement);
export const Loader2Icon = createIcon(HugeLoaderIcon as IconSvgElement);
export const LoaderCircleIcon = createIcon(HugeLoaderIcon as IconSvgElement);
export const LockIcon = createIcon(HugeLockIcon as IconSvgElement);
export const LogoutIcon = createIcon(HugeLogoutIcon as IconSvgElement);
export const MessageSquareTextIcon = createIcon(
  HugeMessageSquareTextIcon as IconSvgElement,
);
export const MinusIcon = createIcon(HugeMinusIcon as IconSvgElement);
export const MoreHorizontal = createIcon(
  HugeMoreHorizontalIcon as IconSvgElement,
);
export const MoreHorizontalIcon = createIcon(
  HugeMoreHorizontalIcon as IconSvgElement,
);
export const MoreVerticalCircleIcon = createIcon(
  HugeMoreVerticalCircleIcon as IconSvgElement,
);
export const NewspaperIcon = createIcon(HugeNewspaperIcon as IconSvgElement);
export const PanelLeftIcon = createIcon(HugePanelLeftIcon as IconSvgElement);
export const PencilEditIcon = createIcon(
  HugePencilEditIcon as IconSvgElement,
);
export const PlusIcon = createIcon(HugePlusIcon as IconSvgElement);
export const PuzzleIcon = createIcon(HugePuzzleIcon as IconSvgElement);
export const PulseIcon = createIcon(HugePulseIcon as IconSvgElement);
export const ArrowUpRight03Icon = createIcon(
  HugeArrowUpRightIcon as IconSvgElement,
);
export const ExchangeIcon = createIcon(HugeExchangeIcon as IconSvgElement);
export const RocketIcon = createIcon(HugeRocketIcon as IconSvgElement);
export const SearchIcon = createIcon(HugeSearchIcon as IconSvgElement);
export const SettingsIcon = createIcon(HugeSettingsIcon as IconSvgElement);
export const SparklesIcon = createIcon(HugeSparklesIcon as IconSvgElement);
export const StarIcon = createIcon(HugeStarIcon as IconSvgElement);
export const StripeIcon = createIcon(HugeStripeIcon as IconSvgElement);
export const TriangleAlertIcon = createIcon(
  HugeTriangleAlertIcon as IconSvgElement,
);
export const UserCircleIcon = createIcon(HugeUserCircleIcon as IconSvgElement);
export const UsersIcon = createIcon(HugeUsersIcon as IconSvgElement);
export const XIcon = createIcon(HugeXIcon as IconSvgElement);
