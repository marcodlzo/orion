'use client';

import CountUp from 'react-countup';

/**
 * Counts up to a balance given in EXACT MINOR UNITS.
 *
 * The division happens here, at the last possible point, because CountUp
 * animates a JS number and there is no integer alternative. Everything upstream
 * — the DTO, the sum across accounts, the store — stays integer.
 *
 * `decimal` was "," and `separator` was unset, so a balance rendered as
 * "$1234,56": a comma where the decimal point belongs and no thousands
 * separator at all. Fixed here rather than left as tutorial noise, because a
 * misplaced decimal separator in a balance is not a cosmetic bug.
 */
const AnimatedCounter = ({ amountMinor }: { amountMinor: number }) => {
  return (
    <div className="w-full">
      <CountUp
        decimals={2}
        decimal="."
        separator=","
        prefix="$"
        end={amountMinor / 100}
      />
    </div>
  )
}

export default AnimatedCounter