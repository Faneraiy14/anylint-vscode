<?php

declare(strict_types=1);

namespace Fixtures;

class Clean
{
    public function add(int $a, int $b): int
    {
        return $a + $b;
    }
}
