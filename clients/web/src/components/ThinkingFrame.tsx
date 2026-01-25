/** biome-ignore-all lint/a11y/noSvgWithoutTitle: ignore */
/** biome-ignore-all lint/suspicious/noExplicitAny: ignore */
/** biome-ignore-all lint/security/noDangerouslySetInnerHtml: ignore */

import { useEffect, useRef } from "react";

type StyleTypes = "purple" | "blue" | "none";

const floodColors = {
  none: "transparent",
  purple: "#6e1fff",
  blue: "#1f41ea",
};

function updateStyle(svg: SVGElement, index: number, style: StyleTypes) {
  const circuit = svg.querySelector(`#circuit-${index}`);
  if (!circuit) return;

  circuit.classList.remove("blue", "purple");
  const filter = svg.querySelector(`#outer-glow-${index}`);
  if (!filter) return;

  circuit.classList.add(style);
  filter
    .querySelector("feFlood")
    ?.setAttribute("flood-color", floodColors[style]);
}

function randomStyle(): StyleTypes {
  const value = Math.random();
  if (value <= 0.2) return "none";
  if (value <= 0.6) return "purple";
  return "blue";
}

type ThinkingFrameProps = {
  count: number;
  className?: string;
};
export default function ThinkingFrame({
  count,
  className,
}: ThinkingFrameProps) {
  const baseRef = useRef(null);
  // Random circuits light up on every render
  useEffect(() => {
    // initial render (count 0) should render black circuits
    // this prevents the thinking animation to flash color, fade to black
    // before real events start streaming in
    if (!baseRef.current || count === 0) return;
    const svg = baseRef.current as SVGElement;

    for (let i = 1; i <= 7; i++) {
      updateStyle(svg, i, randomStyle());
    }
  }, [count]);

  // Fade to black after 1 second if no events come in
  useEffect(() => {
    if (!baseRef.current) return;
    const svg = baseRef.current as SVGElement;
    const timer = setTimeout(() => {
      for (let i = 1; i <= 7; i++) {
        updateStyle(svg, i, "none");
      }
    }, 1000);
    return () => clearTimeout(timer);
  });

  return (
    <svg viewBox="0 0 450 450" className={className} ref={baseRef}>
      <defs>
        <style
          dangerouslySetInnerHTML={{
            __html: `
      .ring {
        fill: none;
        stroke: #000;
        stroke-miterlimit: 10;
        stroke-width: 12px;
      }

      .blue {
        fill: #1f41ea;
        transition: fill 1.0s ease-in-out;
      }
      .purple {
        fill: #6e1fff;
        transition: fill 1.0s ease-in-out;
      }
      .glow-1 {
        filter: url(#outer-glow-1);
        transition: filter 1.0s ease-in-out;
      }

      .glow-2 {
        filter: url(#outer-glow-2);
        transition: filter 1.0s ease-in-out;
      }

      .glow-3 {
        filter: url(#outer-glow-3);
        transition: filter 1.0s ease-in-out;
      }

      .glow-4 {
        filter: url(#outer-glow-4);
        transition: filter 1.0s ease-in-out;
      }

      .glow-5 {
        filter: url(#outer-glow-5);
        transition: filter 1.0s ease-in-out;
      }

      .glow-6 {
        filter: url(#outer-glow-6);
        transition: filter 1.0s ease-in-out;
      }

      .glow-7 {
        filter: url(#outer-glow-7);
        transition: filter 1.0s ease-in-out;
      }
      `,
          }}
        />
        <filter
          id="outer-glow-1"
          x="139"
          y="4"
          width="226"
          height="100"
          filterUnits="userSpaceOnUse"
        >
          <feOffset dx="0" dy="0" />
          <feGaussianBlur result="blur-1" stdDeviation="5" />
          <feFlood floodColor="transparent" floodOpacity=".75" />
          <feComposite in2="blur-1" operator="in" />
          <feComposite in="SourceGraphic" />
        </filter>

        <filter
          id="outer-glow-2"
          x="152"
          y="37"
          width="260"
          height="113"
          filterUnits="userSpaceOnUse"
        >
          <feOffset dx="0" dy="0" />
          <feGaussianBlur result="blur-2" stdDeviation="5" />
          <feFlood floodColor="transparent" floodOpacity=".75" />
          <feComposite in2="blur-2" operator="in" />
          <feComposite in="SourceGraphic" />
        </filter>

        <filter
          id="outer-glow-3"
          x="284"
          y="80"
          width="159"
          height="99"
          filterUnits="userSpaceOnUse"
        >
          <feOffset dx="0" dy="0" />
          <feGaussianBlur result="blur-3" stdDeviation="5" />
          <feFlood floodColor="transparent" floodOpacity=".75" />
          <feComposite in2="blur-3" operator="in" />
          <feComposite in="SourceGraphic" />
        </filter>

        <filter
          id="outer-glow-4"
          x="214"
          y="117"
          width="204"
          height="155"
          filterUnits="userSpaceOnUse"
        >
          <feOffset dx="0" dy="0" />
          <feGaussianBlur result="blur-4" stdDeviation="5" />
          <feFlood floodColor="transparent" floodOpacity=".75" />
          <feComposite in2="blur-4" operator="in" />
          <feComposite in="SourceGraphic" />
        </filter>

        <filter
          id="outer-glow-5"
          x="277"
          y="178"
          width="99"
          height="142"
          filterUnits="userSpaceOnUse"
        >
          <feOffset dx="0" dy="0" />
          <feGaussianBlur result="blur-5" stdDeviation="5" />
          <feFlood floodColor="transparent" floodOpacity=".75" />
          <feComposite in2="blur-5" operator="in" />
          <feComposite in="SourceGraphic" />
        </filter>

        <filter
          id="outer-glow-6"
          x="211"
          y="215"
          width="112"
          height="233"
          filterUnits="userSpaceOnUse"
        >
          <feOffset dx="0" dy="0" />
          <feGaussianBlur result="blur-6" stdDeviation="5" />
          <feFlood floodColor="transparent" floodOpacity=".75" />
          <feComposite in2="blur-6" operator="in" />
          <feComposite in="SourceGraphic" />
        </filter>

        <filter
          id="outer-glow-7"
          x="167"
          y="179"
          width="124"
          height="252"
          filterUnits="userSpaceOnUse"
        >
          <feOffset dx="0" dy="0" />
          <feGaussianBlur result="blur-7" stdDeviation="5" />
          <feFlood floodColor="transparent" floodOpacity=".75" />
          <feComposite in2="blur-7" operator="in" />
          <feComposite in="SourceGraphic" />
        </filter>
      </defs>
      <g>
        <path
          id="face"
          d="M117.51,86.13c-2.16,10.04.14,21.19,5.59,29.88,1.2,1.91,7.3,9.38,8.92,10.07,1.18.51,1.99-.3,1.48-1.48-.6-1.38-4.98-5.53-6.53-8.46-3.39-6.44-5.02-13.1-4.33-20.41.1-1,.4-4.7,1.86-4.61.09,8.48,3.53,16.47,7.98,23.5,5.72,9.06,23.02,26.47,32.32,31.61,9.15,5.06,17.6,6.99,27.64,2.84-7.98,10.4-20.43,6.7-30.97,3,7.45,7.53,19.8,11.39,29.97,6.99-1.68,3.28-5.19,4.82-8.45,6.04l-9.52.94c5.15,1.97,9.74,3.53,15.21,1.74,6.68-2.18,10.22-9.9,18.23-10.75,5.34-.57,10.27,1.12,13.34,5.69,8.87,13.17-.99,32.82-11.91,41.71-6.25,5.09-8.58,1.54-7.77,11.95,2.41,31.25,42.94,48.52,39.72,77.94-3.21,29.3-50.68,53.15-70.83,72.02-17.62,16.5-30.96,38.56-30.97,63.45-1.6-.53-1.93-4.57-2.31-6.17-6.45-27.23,4.69-51.54,20.9-72.65,13.5-17.57,22.9-19.56,20.37-45.55-1.61-16.52-16.31-43.41-34.45-45.47-13.26-1.51-34.37,6.25-45.03,2.07-12.98-5.08-4.02-19.01-5.57-24.34-1.14-3.89-14.39-4.99-4.85-14.69-2.88-.05-7.53-3.9-7.78-6.66-.31-3.35,5.95-6.01,4.65-10.63-1.03-3.68-13.76-5.44-13.78-13.2-.01-4.5,7.35-8.08,9.96-10.94,2.75-3.02,15.22-19.13,12.86-22.44-3.68-.72-8.23-2.86-8.9-7.08,1.95,1.66,8.98,3.61,9.91.37.39-1.38-2.1-14.59-1.9-18.85.64-13.94,7.93-30.43,17-40.94.88-1.02,6.89-7.7,7.96-6.52Z"
        />
        <path
          id="lower-ring"
          className="ring"
          d="M397.37,194.78c.18,3.37.27,6.76.27,10.17,0,82.02-52.59,151.75-125.89,177.31"
        />
        <path
          id="upper-ring"
          className="ring"
          d="M116.62,367.89c-56.43-32.38-94.44-93.22-94.44-162.95C22.18,101.26,106.23,17.21,209.91,17.21c25.44,0,49.7,5.06,71.82,14.23"
        />
        <path
          id="circuit-1"
          className="glow-1"
          d="M334.39,19.62c-8.2,0-14.87,6.67-14.87,14.87,0,2.08.43,4.06,1.21,5.86l-12.9,12.9h-92.25l-16.57,19.92h-21.04c-1.33-5.1-5.95-8.87-11.47-8.87-6.55,0-11.87,5.31-11.87,11.87s5.31,11.87,11.87,11.87c5.52,0,10.14-3.77,11.47-8.87h23.86l16.57-19.92h91.92l13.92-13.92c2.66,2.49,6.23,4.03,10.15,4.03,8.2,0,14.87-6.67,14.87-14.87s-6.67-14.87-14.87-14.87ZM334.39,43.35c-4.89,0-8.87-3.98-8.87-8.87s3.98-8.87,8.87-8.87,8.87,3.98,8.87,8.87-3.98,8.87-8.87,8.87Z"
        />
        <path
          id="circuit-2"
          className="glow-2"
          d="M384.5,52.05c-5.52,0-10.14,3.77-11.47,8.87h-30.48l-23.58,17.65h-86.42l-19.5,23.35h-20.73l-8.21,10.07c-1.5-.69-3.17-1.08-4.92-1.08-6.55,0-11.87,5.31-11.87,11.87s5.31,11.87,11.87,11.87,11.87-5.31,11.87-11.87c0-2.62-.86-5.03-2.29-6.99l6.41-7.86h80.47c1.39,6.76,7.39,11.87,14.56,11.87,8.2,0,14.87-6.67,14.87-14.87s-6.67-14.87-14.87-14.87c-7.17,0-13.17,5.1-14.56,11.87h-54.78l14.49-17.35h85.61l23.58-17.65h28.49c1.33,5.1,5.95,8.87,11.47,8.87,6.55,0,11.87-5.31,11.87-11.87s-5.31-11.87-11.87-11.87ZM290.2,96.05c4.89,0,8.87,3.98,8.87,8.87s-3.98,8.87-8.87,8.87-8.87-3.98-8.87-8.87,3.98-8.87,8.87-8.87Z"
        />
        <path
          id="circuit-3"
          className="glow-3"
          d="M412.96,95.46c-7.16,0-13.15,5.08-14.55,11.83l-48.46-.69-33.76,33.76c-1.37-.56-2.87-.87-4.44-.87-6.55,0-11.87,5.31-11.87,11.87s5.31,11.87,11.87,11.87,11.87-5.31,11.87-11.87c0-2.79-.97-5.34-2.57-7.37l31.36-31.36,45.99.65c1.38,6.78,7.39,11.91,14.57,11.91,8.2,0,14.87-6.67,14.87-14.87s-6.67-14.87-14.87-14.87ZM412.96,119.19c-4.89,0-8.87-3.98-8.87-8.87s3.98-8.87,8.87-8.87,8.87,3.98,8.87,8.87-3.98,8.87-8.87,8.87Z"
        />
        <path
          id="circuit-4"
          className="glow-4"
          d="M387.71,135.54c-8.2,0-14.87,6.67-14.87,14.87,0,3.03.91,5.84,2.47,8.19l-16.72,16.77h-84.93l-17.26-19.59c1.84-2.47,2.94-5.52,2.94-8.83,0-8.2-6.67-14.87-14.87-14.87s-14.87,6.67-14.87,14.87,6.67,14.87,14.87,14.87c2.72,0,5.27-.75,7.46-2.03l19.02,21.59h53.14s27.14,29.3,27.14,29.3v22.96c-5.1,1.33-8.87,5.95-8.87,11.47,0,6.55,5.31,11.87,11.87,11.87s11.87-5.31,11.87-11.87c0-5.52-3.77-10.14-8.87-11.47v-25.31l-24.96-26.94h27.5s1.28.03,1.28.03l18.52-18.57c2.34,1.54,5.14,2.44,8.14,2.44,8.2,0,14.87-6.67,14.87-14.87s-6.67-14.87-14.87-14.87ZM235.59,146.95c0-4.89,3.98-8.87,8.87-8.87s8.87,3.98,8.87,8.87-3.98,8.87-8.87,8.87-8.87-3.98-8.87-8.87ZM387.71,159.27c-4.89,0-8.87-3.98-8.87-8.87s3.98-8.87,8.87-8.87,8.87,3.98,8.87,8.87-3.98,8.87-8.87,8.87Z"
        />
        <path
          id="circuit-5"
          className="glow-5"
          d="M345.81,275.03c-2.5,0-4.86.63-6.93,1.72l-7.86-9.55v-32.72l-17.44-21.59c1.46-1.97,2.33-4.4,2.33-7.04,0-6.55-5.31-11.87-11.87-11.87s-11.87,5.31-11.87,11.87,5.31,11.87,11.87,11.87c1.74,0,3.39-.38,4.88-1.06l16.11,19.94v32.75l9.23,11.22c-2.06,2.55-3.31,5.8-3.31,9.33,0,8.2,6.67,14.87,14.87,14.87s14.87-6.67,14.87-14.87-6.67-14.87-14.87-14.87ZM345.81,298.77c-4.89,0-8.87-3.98-8.87-8.87s3.98-8.87,8.87-8.87,8.87,3.98,8.87,8.87-3.98,8.87-8.87,8.87Z"
        />
        <path
          id="circuit-6"
          className="glow-6"
          d="M306.88,317.3l.39-44.23-18.57-23.14c1.47-1.98,2.35-4.42,2.35-7.07,0-6.55-5.31-11.87-11.87-11.87s-11.87,5.31-11.87,11.87,5.31,11.87,11.87,11.87c1.73,0,3.36-.38,4.84-1.04l17.22,21.46-.35,39.65-62.45,62.75v25.8c-6.76,1.39-11.87,7.39-11.87,14.56,0,8.2,6.67,14.87,14.87,14.87s14.87-6.67,14.87-14.87c0-7.17-5.1-13.17-11.87-14.56v-23.33l62.43-62.73ZM250.32,417.92c0,4.89-3.98,8.87-8.87,8.87s-8.87-3.98-8.87-8.87,3.98-8.87,8.87-8.87,8.87,3.98,8.87,8.87Z"
        />
        <path
          id="circuit-7"
          className="glow-7"
          d="M275.36,301.59l.03-26.87-34.09-37.32v-13.14c6.76-1.39,11.87-7.39,11.87-14.56,0-8.2-6.67-14.87-14.87-14.87s-14.87,6.67-14.87,14.87c0,7.17,5.1,13.17,11.87,14.56v15.46l34.08,37.32-.03,22.06-78.24,78.17v15.39c-5.1,1.33-8.87,5.95-8.87,11.47,0,6.55,5.31,11.87,11.87,11.87s11.87-5.31,11.87-11.87c0-5.52-3.77-10.14-8.87-11.47v-12.9l78.24-78.17ZM229.44,209.7c0-4.89,3.98-8.87,8.87-8.87s8.87,3.98,8.87,8.87-3.98,8.87-8.87,8.87-8.87-3.98-8.87-8.87Z"
        />
      </g>
    </svg>
  );
}
