import React, { useLayoutEffect, useRef } from "react";
import { ArrowLeft, ExternalLink, Server } from "lucide-react";
import { Link } from "react-router-dom";
import { copy } from "../lib/copy";
import { Button } from "../ui/components/Button.jsx";

export function SelfHostPage() {
  const pageRef=useRef(null);
  useLayoutEffect(()=>{
    const scroller=pageRef.current?.parentElement;
    if(scroller) scroller.scrollTop=0;
  },[]);
  const steps = [
    [copy("self_host.step.backend_title"), copy("self_host.step.backend_body")],
    [copy("self_host.step.schema_title"), copy("self_host.step.schema_body")],
    [copy("self_host.step.client_title"), copy("self_host.step.client_body")],
  ];
  return (
    <div ref={pageRef} className="tt-cloud-theme flex flex-1 flex-col font-oai text-oai-black dark:text-oai-white">
      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        <Link to="/cloud" className="mb-7 inline-flex min-h-10 items-center gap-2 text-sm text-oai-gray-600 dark:text-oai-gray-300">
          <ArrowLeft size={16} aria-hidden />
          {copy("self_host.back")}
        </Link>
        <div className="mb-3 flex items-center gap-2 text-sm text-oai-gray-600 dark:text-oai-gray-300">
          <Server size={18} aria-hidden />
          <span>{copy("self_host.status")}</span>
        </div>
        <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          {copy("self_host.title")}
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-oai-gray-600 dark:text-oai-gray-300">
          {copy("self_host.subtitle")}
        </p>
        <div className="mt-7 rounded-lg border border-oai-gray-300 p-5 dark:border-oai-gray-700">
          <h2 className="text-sm font-semibold">{copy("self_host.preview_title")}</h2>
          <p className="mt-2 text-sm leading-6 text-oai-gray-600 dark:text-oai-gray-300">
            {copy("self_host.preview_body")}
          </p>
        </div>
        <section className="mt-10">
          <h2 className="text-lg font-semibold">{copy("self_host.steps_title")}</h2>
          <ol className="mt-5 list-decimal space-y-6 pl-5 marker:text-oai-gray-500">
            {steps.map(([title, body]) => (
              <li key={title} className="pl-2">
                <h3 className="text-sm font-medium">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-oai-gray-600 dark:text-oai-gray-300">{body}</p>
              </li>
            ))}
          </ol>
        </section>
        <section className="mt-9 border-t border-oai-gray-200 pt-7 dark:border-oai-gray-800">
          <h2 className="text-lg font-semibold">{copy("self_host.responsibility_title")}</h2>
          <p className="mt-3 text-sm leading-6 text-oai-gray-600 dark:text-oai-gray-300">
            {copy("self_host.responsibility_body")}
          </p>
          <p className="mt-3 text-sm leading-6 text-oai-gray-600 dark:text-oai-gray-300">
            {copy("self_host.community")}
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button as="a" href="https://github.com/InsForge/InsForge#self-hosted-docker-compose" target="_blank" rel="noopener noreferrer" variant="secondary" className="no-underline">
              {copy("self_host.link.insforge")}
              <ExternalLink size={14} className="ml-2" aria-hidden />
            </Button>
            <Button as="a" href="https://github.com/xiufengsun/TokenTracker/tree/main/dashboard/edge-patches" target="_blank" rel="noopener noreferrer" variant="secondary" className="no-underline">
              {copy("self_host.link.source")}
              <ExternalLink size={14} className="ml-2" aria-hidden />
            </Button>
          </div>
        </section>
        <section className="mt-9 border-t border-oai-gray-200 pt-7 dark:border-oai-gray-800">
          <h2 className="text-base font-semibold">{copy("self_host.managed_title")}</h2>
          <p className="mt-2 text-sm leading-6 text-oai-gray-600 dark:text-oai-gray-300">{copy("self_host.managed_body")}</p>
          <Button as={Link} to="/cloud" className="mt-4 no-underline">{copy("self_host.link.cloud")}</Button>
        </section>
      </main>
    </div>
  );
}
