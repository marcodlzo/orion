'use client';

// Uses useState, useEffect, useCallback and usePlaidLink, so this is a client
// component. It previously had no directive and worked only because AuthForm
// and Sidebar (both client components) import it — the boundary was inherited
// rather than declared.
import React, { useCallback, useEffect, useState } from 'react'
import { Button } from './ui/button'
import { PlaidLinkOnSuccess, PlaidLinkOptions, usePlaidLink } from 'react-plaid-link'
import { useRouter } from 'next/navigation';
import { createLinkToken, exchangePublicToken } from '@/lib/actions/user.actions';
import Image from 'next/image';

const PlaidLink = ({ variant }: PlaidLinkProps) => {
  const router = useRouter();

  const [token, setToken] = useState('');

  useEffect(() => {
    const getLinkToken = async () => {
      const data = await createLinkToken();

      setToken(data?.linkToken);
    }

    getLinkToken();
  }, []);

  const [linkError, setLinkError] = useState("");

  const onSuccess = useCallback<PlaidLinkOnSuccess>(async (public_token: string) => {
    setLinkError("");

    const result = await exchangePublicToken({
      publicToken: public_token,
    })

    // NAVIGATE ONLY ON SUCCESS. This used to push to the dashboard
    // unconditionally, so a failed link was indistinguishable from a working
    // one — the user landed on a page with no bank and no explanation.
    if (result?.publicTokenExchange === "complete") {
      router.push('/');
      return;
    }

    setLinkError("We could not finish linking that bank. Please try again.");
  }, [router])
  
  const config: PlaidLinkOptions = {
    token,
    onSuccess
  }

  const { open, ready } = usePlaidLink(config);
  
  return (
    <>
      {linkError ? (
        <p role="alert" className="text-14 mb-2 text-red-500">
          {linkError}
        </p>
      ) : null}
      {variant === 'primary' ? (
        <Button
          onClick={() => open()}
          disabled={!ready}
          className="plaidlink-primary"
        >
          Connect bank
        </Button>
      ): variant === 'ghost' ? (
        <Button onClick={() => open()} variant="ghost" className="plaidlink-ghost">
          <Image 
            src="/icons/connect-bank.svg"
            alt="connect bank"
            width={24}
            height={24}
          />
          <p className='hiddenl text-[16px] font-semibold text-black-2 xl:block'>Connect bank</p>
        </Button>
      ): (
        <Button onClick={() => open()} className="plaidlink-default">
          <Image 
            src="/icons/connect-bank.svg"
            alt="connect bank"
            width={24}
            height={24}
          />
          <p className='text-[16px] font-semibold text-black-2'>Connect bank</p>
        </Button>
      )}
    </>
  )
}

export default PlaidLink